import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  listenHostForMode,
  loadConfig,
  parseConnectionMode,
  parseEnvFile,
  parseNullSeparatedEnvironment,
  parseOAuthResourceAliases,
  resolveConfiguredPath,
  sourceShellEnvironment,
} from "../src/config.js";

test("connection mode defaults to remote and maps to fixed listener hosts", () => {
  assert.equal(parseConnectionMode(undefined), "remote");
  assert.equal(parseConnectionMode(""), "remote");
  assert.equal(parseConnectionMode("local"), "local");
  assert.equal(parseConnectionMode("remote"), "remote");
  assert.equal(listenHostForMode("local"), "127.0.0.1");
  assert.equal(listenHostForMode("remote"), "0.0.0.0");
  assert.throws(() => parseConnectionMode("public"), /Invalid MODE: public/);
});

test("OAuth resource aliases are exact HTTPS identifiers and are deduplicated", () => {
  assert.deepEqual(
    parseOAuthResourceAliases(
      "https://tunnel.example/v1/mcp/one, https://tunnel.example/v1/mcp/one,https://gateway.example/mcp/",
    ),
    [
      "https://tunnel.example/v1/mcp/one",
      "https://gateway.example/mcp/",
    ],
  );
  assert.deepEqual(parseOAuthResourceAliases(""), []);
  assert.deepEqual(parseOAuthResourceAliases(undefined), []);
});

test("OAuth resource aliases reject non-HTTPS, credentials, fragments, and malformed values", () => {
  for (const value of [
    "http://tunnel.example/mcp",
    "https://user:pass@tunnel.example/mcp",
    "https://tunnel.example/mcp#fragment",
    "https:tunnel.example/mcp",
    "not-a-url",
  ]) {
    assert.throws(
      () => parseOAuthResourceAliases(value),
      /Invalid OAUTH_RESOURCE_ALIASES entry/,
    );
  }
});

test("loadConfig requires PUBLIC_BASE_URL to be an HTTPS origin", async () => {
  const home = await mkdtemp(join(tmpdir(), "mcp-shell-remote-config-test-"));
  const originalEnv = { ...process.env };

  try {
    process.env.HOME = home;

    const configDir = join(home, ".mcp-shell");
    await mkdir(configDir, { recursive: true });

    for (const publicBaseUrl of [
      "http://mcp.example.test",
      "https://mcp.example.test/path",
      "https://mcp.example.test?tenant=one",
    ]) {
      await writeFile(join(configDir, "env"), [
        "MODE=remote",
        `PUBLIC_BASE_URL=${publicBaseUrl}`,
        "OAUTH_CLIENT_ID=chatgpt",
        "OAUTH_CLIENT_SECRET=client-secret",
        "ADMIN_PASSWORD=admin-password",
        "",
      ].join("\n"), "utf8");

      await assert.rejects(
        () => loadConfig(),
        /Invalid PUBLIC_BASE_URL/,
      );
    }
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    await rm(home, { recursive: true, force: true });
  }
});

test("loadConfig accepts local mode without remote OAuth configuration", async () => {
  const home = await mkdtemp(join(tmpdir(), "mcp-shell-local-config-test-"));
  const originalEnv = { ...process.env };

  try {
    process.env.HOME = home;
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.OAUTH_CLIENT_ID;
    delete process.env.OAUTH_CLIENT_SECRET;
    delete process.env.ADMIN_PASSWORD;

    const configDir = join(home, ".mcp-shell");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "env"), [
      "MODE=local",
      "PORT=4312",
      "WEB_PASSWORD=dashboard-secret",
      "OBSERVABILITY_TOKEN=monitor-secret",
      "TOOL_LOG_DIR=logs",
      "TOOL_LOG_MAX_CALLS=123",
      "",
    ].join("\n"), "utf8");

    const config = await loadConfig();
    assert.equal(config.mode, "local");
    assert.equal(config.port, 4312);
    assert.equal(config.paths.shellsDbFile, join(configDir, "shells.db"));
    assert.equal(config.webPassword, "dashboard-secret");
    assert.equal(config.observabilityToken, "monitor-secret");
    assert.equal(config.toolLogs.dir, join(configDir, "logs"));
    assert.equal(config.toolLogs.maxCalls, 123);
    assert.equal("publicBaseUrl" in config, false);
    assert.equal("oauth" in config, false);
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    await rm(home, { recursive: true, force: true });
  }
});

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
