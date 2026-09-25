import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseEnvFile,
  parseNullSeparatedEnvironment,
  resolveConfiguredPath,
  sourceShellEnvironment,
} from "../src/config.js";

test("parseEnvFile parses simple dotenv values without shell evaluation", () => {
  assert.deepEqual(
    parseEnvFile([
      "# comment",
      "PLAIN=value",
      "DOUBLE=\"$HOME/bin:$PATH\"",
      "SINGLE='literal value'",
      "EMPTY=",
      "",
    ].join("\n")),
    {
      PLAIN: "value",
      DOUBLE: "$HOME/bin:$PATH",
      SINGLE: "literal value",
      EMPTY: "",
    },
  );
});

test("resolveConfiguredPath expands home and resolves relative paths from config dir", () => {
  const configDir = "/tmp/mcp-shell-config";
  assert.equal(resolveConfiguredPath("~/.shellenv", configDir), join(homedir(), ".shellenv"));
  assert.equal(resolveConfiguredPath("profiles/env.sh", configDir), join(configDir, "profiles/env.sh"));
  assert.equal(resolveConfiguredPath("/opt/example/env.sh", configDir), "/opt/example/env.sh");
});

test("parseNullSeparatedEnvironment preserves values including newlines and equals signs", () => {
  const raw = Buffer.from("A=one\0B=line1\nline2\0C=x=y=z\0", "utf8");
  assert.deepEqual(parseNullSeparatedEnvironment(raw), {
    A: "one",
    B: "line1\nline2",
    C: "x=y=z",
  });
});

test("sourceShellEnvironment evaluates shell syntax, sourced files, and unexported assignments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-env-test-"));
  const childFile = join(dir, "child env.sh");
  const envFile = join(dir, "main env.sh");

  try {
    await writeFile(childFile, 'CHILD_VALUE="from child"\n', "utf8");
    await writeFile(
      envFile,
      [
        'PATH="$HOME/custom-bin:$PATH"',
        'UNEXPORTED_VALUE="set by source"',
        `source ${JSON.stringify(childFile)}`,
        'printf "noise on stdout\\n"',
        "",
      ].join("\n"),
      "utf8",
    );

    const env = await sourceShellEnvironment(envFile);
    assert.equal(env.UNEXPORTED_VALUE, "set by source");
    assert.equal(env.CHILD_VALUE, "from child");
    assert.ok(env.PATH?.startsWith(`${process.env.HOME}/custom-bin:`));
    assert.equal(env.HOME, process.env.HOME);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sourceShellEnvironment fails when the configured shell file cannot be sourced", async () => {
  const missing = join(tmpdir(), `missing-shell-env-${process.pid}-${Date.now()}.sh`);
  await assert.rejects(
    () => sourceShellEnvironment(missing),
    new RegExp(`Failed to load shell environment from ${missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
});
