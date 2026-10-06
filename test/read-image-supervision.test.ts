import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProcessSupervisor } from "../src/host/process-supervisor.js";
import { readImage } from "../src/tools/read-image.js";

const JPEG_1X1 = Buffer.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x07, 0x08, 0x00, 0x01, 0x00, 0x01,
]);

test("read_image uses a supervised ImageMagick child on successful normalization", async () => {
  await withFixture(async ({ dir, sourcePath, normalizedPath, userBinDir, repoBinDir }) => {
    await writeExecutable(
      join(userBinDir, "magick"),
      `#!/bin/bash
cat "${normalizedPath}"
`,
    );

    const processes = new ProcessSupervisor();
    try {
      const result = await readImage(
        dir,
        sourcePath,
        undefined,
        { userBinDir, repoBinDir },
        processes,
      );

      const text = result.content.find((item) => item.type === "text");
      const image = result.content.find((item) => item.type === "image");
      assert.ok(text && text.type === "text");
      assert.match(text.text, /1x1/);
      assert.ok(image && image.type === "image");
      assert.equal(image.data, JPEG_1X1.toString("base64"));
    } finally {
      await processes.close();
    }
  });
});

test("read_image abort terminates its supervised ImageMagick process group", async () => {
  await withFixture(async ({ dir, sourcePath, userBinDir, repoBinDir }) => {
    const marker = join(dir, "magick-started");
    await writeExecutable(
      join(userBinDir, "magick"),
      `#!/bin/bash
printf started > "${marker}"
sleep 30
`,
    );

    const processes = new ProcessSupervisor();
    const controller = new AbortController();
    try {
      const running = readImage(
        dir,
        sourcePath,
        controller.signal,
        { userBinDir, repoBinDir },
        processes,
      );

      await waitForFile(marker);
      controller.abort();
      await assert.rejects(running, /cancelled/);
    } finally {
      await processes.close();
    }
  });
});

test("process supervisor shutdown terminates an active read_image child", async () => {
  await withFixture(async ({ dir, sourcePath, userBinDir, repoBinDir }) => {
    const marker = join(dir, "magick-started");
    await writeExecutable(
      join(userBinDir, "magick"),
      `#!/bin/bash
printf started > "${marker}"
sleep 30
`,
    );

    const processes = new ProcessSupervisor();
    const running = readImage(
      dir,
      sourcePath,
      undefined,
      { userBinDir, repoBinDir },
      processes,
    );

    await waitForFile(marker);
    await processes.close();
    await assert.rejects(running, /Could not normalize image/);
  });
});

async function withFixture(
  callback: (fixture: {
    dir: string;
    sourcePath: string;
    normalizedPath: string;
    userBinDir: string;
    repoBinDir: string;
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-image-test-"));
  const userBinDir = join(dir, "user-bin");
  const repoBinDir = join(dir, "repo-bin");
  const sourcePath = join(dir, "input.jpg");
  const normalizedPath = join(dir, "normalized.jpg");

  await mkdir(userBinDir);
  await mkdir(repoBinDir);
  await writeFile(sourcePath, JPEG_1X1);
  await writeFile(normalizedPath, JPEG_1X1);

  try {
    await callback({ dir, sourcePath, normalizedPath, userBinDir, repoBinDir });
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
