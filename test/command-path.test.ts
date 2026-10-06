import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { applyCommandPath, resolveExecutable } from "../src/command-path.js";

const policy = {
  userBinDir: "/user/bin",
  repoBinDir: "/repo/bin",
};

test("applyCommandPath pins user and repo bins before the existing PATH", () => {
  const input = ["/a", policy.repoBinDir, "/b", policy.userBinDir, "/c"].join(delimiter);
  const result = applyCommandPath({ PATH: input }, policy);

  assert.equal(
    result.PATH,
    [policy.userBinDir, policy.repoBinDir, "/a", "/b", "/c"].join(delimiter),
  );
});

test("applyCommandPath is idempotent", () => {
  const once = applyCommandPath({ PATH: ["/a", "/b"].join(delimiter) }, policy);
  const twice = applyCommandPath(once, policy);

  assert.deepEqual(twice, once);
});

test("resolveExecutable follows the effective PATH order", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-command-path-"));
  const first = join(dir, "first");
  const second = join(dir, "second");
  await mkdir(first);
  await mkdir(second);
  await writeFile(join(first, "probe"), "#!/bin/sh\n");
  await writeFile(join(second, "probe"), "#!/bin/sh\n");
  await chmod(join(first, "probe"), 0o755);
  await chmod(join(second, "probe"), 0o755);

  try {
    assert.equal(
      resolveExecutable("probe", { cwd: dir, env: { PATH: [first, second].join(delimiter) } }),
      join(first, "probe"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveExecutable resolves explicit relative commands from the child cwd and requires executable permission", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-command-relative-"));
  const bin = join(dir, "tools");
  const executable = join(bin, "server");
  await mkdir(bin);
  await writeFile(executable, "#!/bin/sh\n");

  try {
    assert.equal(resolveExecutable("./tools/server", { cwd: dir, env: {} }), undefined);
    await chmod(executable, 0o755);
    assert.equal(resolveExecutable("./tools/server", { cwd: dir, env: {} }), executable);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveExecutable honors PATHEXT on Windows", { skip: process.platform !== "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-command-pathext-"));
  const executable = join(dir, "probe.CMD");
  await writeFile(executable, "@echo off\r\n");

  try {
    assert.equal(
      resolveExecutable("probe", { cwd: dir, env: { PATH: dir, PATHEXT: ".CMD;.EXE" } }),
      executable,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
