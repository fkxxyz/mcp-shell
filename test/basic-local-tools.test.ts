import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileMutationCoordinator } from "../src/host/file-mutation-coordinator.js";
import { ProcessSupervisor } from "../src/host/process-supervisor.js";
import { runBash } from "../src/tools/basic/bash.js";
import { editTextFile } from "../src/tools/basic/edit.js";
import { readTextFile } from "../src/tools/basic/read.js";
import { writeTextFile } from "../src/tools/basic/write.js";

test("read streams bounded text and supports continuation offsets", async () => {
  await withTempDir(async (dir) => {
    const lines = Array.from({ length: 2_105 }, (_, index) => `line-${index + 1}`);
    await writeFile(join(dir, "large.txt"), lines.join("\n"));

    const first = await readTextFile(dir, { path: "large.txt" });
    assert.match(first.content[0].text, /line-1/);
    assert.match(first.content[0].text, /line-2000/);
    assert.doesNotMatch(first.content[0].text, /line-2001/);
    assert.match(first.content[0].text, /offset=2001/);
    assert.equal(first.details?.truncated, true);

    const second = await readTextFile(dir, { path: "large.txt", offset: 2001, limit: 5 });
    assert.match(second.content[0].text, /^line-2001/);
    assert.match(second.content[0].text, /line-2005/);
    assert.match(second.content[0].text, /offset=2006/);
  });
});

test("read rejects images and does not buffer an oversized single line", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "huge.txt"), "x".repeat(60 * 1024));
    const huge = await readTextFile(dir, { path: "huge.txt" });
    assert.match(huge.content[0].text, /exceeds the 50 KiB read limit/);

    await assert.rejects(
      () => readTextFile(dir, { path: "image.png" }),
      /use read_image/i,
    );
  });
});

test("write creates parents and reports UTF-8 byte count", async () => {
  await withTempDir(async (dir) => {
    const mutations = new FileMutationCoordinator();
    const result = await writeTextFile(
      dir,
      { path: "nested/value.txt", content: "你好" },
      mutations,
    );

    assert.equal(await readFile(join(dir, "nested/value.txt"), "utf8"), "你好");
    assert.match(result.content[0].text, /6 bytes/);
  });
});

test("edit is exact apart from line-ending normalization and preserves BOM/CRLF", async () => {
  await withTempDir(async (dir) => {
    const mutations = new FileMutationCoordinator();
    const path = join(dir, "value.txt");
    await writeFile(path, "\uFEFFalpha\r\nbeta\r\nomega\r\n");

    const result = await editTextFile(
      dir,
      {
        path: "value.txt",
        edits: [
          { oldText: "alpha\nbeta", newText: "alpha\ngamma" },
          { oldText: "omega", newText: "done" },
        ],
      },
      mutations,
    );

    assert.equal(await readFile(path, "utf8"), "\uFEFFalpha\r\ngamma\r\ndone\r\n");
    assert.match(String(result.details?.patch), /gamma/);
  });
});

test("edit rejects fuzzy, duplicate, overlapping, and no-op replacements", async () => {
  await withTempDir(async (dir) => {
    const mutations = new FileMutationCoordinator();
    await writeFile(join(dir, "smart.txt"), "const value = “smart”;\n");
    await assert.rejects(
      () => editTextFile(
        dir,
        { path: "smart.txt", edits: [{ oldText: 'const value = "smart";', newText: "changed" }] },
        mutations,
      ),
      /Could not find the exact text/,
    );

    await writeFile(join(dir, "duplicate.txt"), "same same\n");
    await assert.rejects(
      () => editTextFile(
        dir,
        { path: "duplicate.txt", edits: [{ oldText: "same", newText: "x" }] },
        mutations,
      ),
      /more than once/,
    );

    await writeFile(join(dir, "overlap.txt"), "abcdef\n");
    await assert.rejects(
      () => editTextFile(
        dir,
        {
          path: "overlap.txt",
          edits: [
            { oldText: "abcd", newText: "x" },
            { oldText: "cdef", newText: "y" },
          ],
        },
        mutations,
      ),
      /overlap/,
    );

    await assert.rejects(
      () => editTextFile(
        dir,
        { path: "overlap.txt", edits: [{ oldText: "abcdef", newText: "abcdef" }] },
        mutations,
      ),
      /No changes made/,
    );
  });
});

test("bash uses pinned PATH, reports failures, and truncates large output", async () => {
  await withTempDir(async (dir) => {
    const userBinDir = join(dir, "user-bin");
    const repoBinDir = join(dir, "repo-bin");
    await mkdir(userBinDir);
    await mkdir(repoBinDir);
    await writeExecutable(join(userBinDir, "path-probe"), "#!/bin/bash\nprintf user\n");
    await writeExecutable(join(repoBinDir, "path-probe"), "#!/bin/bash\nprintf repo\n");

    const processes = new ProcessSupervisor();
    const commandPath = { userBinDir, repoBinDir };
    try {
      const pathResult = await runBash(dir, { command: "path-probe" }, commandPath, processes);
      assert.equal(pathResult.content[0].text, "user");

      await assert.rejects(
        () => runBash(dir, { command: "printf failure >&2; exit 7" }, commandPath, processes),
        /failure[\s\S]*Command exited with code 7/,
      );

      const large = await runBash(
        dir,
        { command: 'for ((i=1;i<=2500;i++)); do echo "$i"; done' },
        commandPath,
        processes,
      );
      assert.equal(large.details?.truncated, true);
      assert.match(large.content[0].text, /2500/);
      assert.match(large.content[0].text, /Output truncated/);
    } finally {
      await processes.close();
    }
  });
});

test("bash timeout and supervisor shutdown terminate managed process groups", async () => {
  await withTempDir(async (dir) => {
    const commandPath = {
      userBinDir: join(dir, "user-bin"),
      repoBinDir: join(dir, "repo-bin"),
    };
    await mkdir(commandPath.userBinDir);
    await mkdir(commandPath.repoBinDir);

    const timed = new ProcessSupervisor();
    try {
      await assert.rejects(
        () => runBash(dir, { command: "sleep 30", timeout: 0.05 }, commandPath, timed),
        /timed out after 0.05 seconds/,
      );
    } finally {
      await timed.close();
    }

    const supervised = new ProcessSupervisor();
    const running = assert.rejects(
      runBash(
        dir,
        { command: 'printf "%s" "$$" > shell.pid; sleep 30' },
        commandPath,
        supervised,
      ),
      /terminated by signal/,
    );
    await waitForFile(join(dir, "shell.pid"));
    await supervised.close();
    await running;
  });
});

test("supervisor kills surviving process-group descendants after the leader exits on TERM", {
  skip: process.platform === "win32",
}, async () => {
  await withTempDir(async (dir) => {
    const commandPath = {
      userBinDir: join(dir, "user-bin"),
      repoBinDir: join(dir, "repo-bin"),
    };
    await mkdir(commandPath.userBinDir);
    await mkdir(commandPath.repoBinDir);

    const supervised = new ProcessSupervisor();
    const running = runBash(
      dir,
      {
        command:
          "(trap '' TERM; printf '%s' \"$BASHPID\" > grandchild.pid; while :; do sleep 1; done) " +
          "</dev/null >/dev/null 2>&1 & " +
          "printf '%s' \"$$\" > shell.pid; trap 'exit 0' TERM; while :; do sleep 1; done",
      },
      commandPath,
      supervised,
    );

    await waitForFile(join(dir, "shell.pid"));
    await waitForFile(join(dir, "grandchild.pid"));
    const grandchildPid = Number(await readFile(join(dir, "grandchild.pid"), "utf8"));
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);

    await supervised.close();
    await running;
    await waitForPidToDisappear(grandchildPid);
  });
});

async function withTempDir(callback: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-basic-test-"));
  try {
    await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await readFile(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForPidToDisappear(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0);
    } catch (error: any) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Process ${pid} remained alive after supervisor shutdown`);
}
