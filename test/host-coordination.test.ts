import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileMutationCoordinator } from "../src/host/file-mutation-coordinator.js";

test("same-file mutations serialize while unrelated files stay concurrent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-mutation-test-"));
  const firstPath = join(dir, "first.txt");
  const secondPath = join(dir, "second.txt");
  await writeFile(firstPath, "first");
  await writeFile(secondPath, "second");

  const coordinator = new FileMutationCoordinator();
  let releaseFirst!: () => void;
  let firstEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  try {
    const first = coordinator.runExclusive([firstPath], async () => {
      firstEntered();
      await hold;
      return "first";
    });
    await entered;

    let sameEntered = false;
    const same = coordinator.runExclusive([firstPath], async () => {
      sameEntered = true;
      return "same";
    });

    let otherEntered!: () => void;
    const otherStarted = new Promise<void>((resolve) => {
      otherEntered = resolve;
    });
    const other = coordinator.runExclusive([secondPath], async () => {
      otherEntered();
      return "other";
    });

    await Promise.race([
      otherStarted,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("unrelated mutation was unexpectedly blocked")), 250);
      }),
    ]);
    assert.equal(sameEntered, false);

    releaseFirst();
    assert.deepEqual(await Promise.all([first, same, other]), ["first", "same", "other"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("nonexistent targets through a directory symlink share the same mutation key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-mutation-test-"));
  const realDirectory = join(dir, "real");
  const aliasDirectory = join(dir, "alias");
  await mkdir(realDirectory);
  await symlink(realDirectory, aliasDirectory, "dir");

  const coordinator = new FileMutationCoordinator();
  let releaseFirst!: () => void;
  let firstEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  try {
    const first = coordinator.runExclusive([join(aliasDirectory, "new.txt")], async () => {
      firstEntered();
      await hold;
    });
    await entered;

    let secondEntered = false;
    const second = coordinator.runExclusive([join(realDirectory, "new.txt")], async () => {
      secondEntered = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(secondEntered, false);

    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(secondEntered, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("multi-path acquisition is order-independent and does not deadlock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-mutation-test-"));
  const a = join(dir, "a.txt");
  const b = join(dir, "b.txt");
  const coordinator = new FileMutationCoordinator();

  try {
    const order: string[] = [];
    await Promise.all([
      coordinator.runExclusive([a, b], async () => {
        order.push("first-start");
        await new Promise((resolve) => setImmediate(resolve));
        order.push("first-end");
      }),
      coordinator.runExclusive([b, a], async () => {
        order.push("second");
      }),
    ]);

    assert.deepEqual(order, ["first-start", "first-end", "second"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
