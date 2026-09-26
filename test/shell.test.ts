import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { LocalAppConfig } from "../src/config.js";
import { createApp } from "../src/http/app.js";
import { ShellStore } from "../src/shell-store.js";
import { createShell } from "../src/shell.js";

test("shell IDs persist and increase across store reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-store-test-"));
  const project = join(dir, "project");
  const dbFile = join(dir, "shells.db");
  await mkdir(project);

  try {
    let store = await ShellStore.open(dir, dbFile);
    const first = store.create(project);
    const second = store.create(project);
    assert.ok(second.id > first.id);
    store.close();

    store = await ShellStore.open(dir, dbFile);
    assert.equal(store.require(first.id).cwd, project);
    const third = store.create(project);
    assert.ok(third.id > second.id);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createShell returns concise bootstrap instructions without AGENTS.md", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-bootstrap-test-"));
  const project = join(dir, "project");
  await mkdir(project);
  const store = await ShellStore.open(dir, join(dir, "shells.db"));

  try {
    const result = await createShell(store, project);
    assert.equal(
      result.instructions,
      `Shell ${result.shellId} is rooted at ${project}.\nUse this shell for subsequent operations and prefer relative paths.`,
    );
    assert.equal(store.require(result.shellId).cwd, project);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("createShell appends root AGENTS.md to bootstrap instructions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-agents-test-"));
  const project = join(dir, "project");
  await mkdir(project);
  await writeFile(join(project, "AGENTS.md"), "# Repository rules\n\nRun tests.\n", "utf8");
  const store = await ShellStore.open(dir, join(dir, "shells.db"));

  try {
    const result = await createShell(store, project);
    assert.equal(
      result.instructions,
      `Shell ${result.shellId} is rooted at ${project}.\nUse this shell for subsequent operations and prefer relative paths.\n\nProject instructions from AGENTS.md:\n\n# Repository rules\n\nRun tests.`,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("createShell rejects invalid roots before allocating a shell", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-invalid-test-"));
  const project = join(dir, "project");
  await mkdir(project);
  const store = await ShellStore.open(dir, join(dir, "shells.db"));

  try {
    await assert.rejects(() => createShell(store, "relative/path"), /cwd must be an absolute path/);
    await assert.rejects(() => createShell(store, join(dir, "missing")), /Cannot access shell cwd/);
    const first = await createShell(store, project);
    assert.equal(first.shellId, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("createShell rejects a non-file AGENTS.md before allocation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-agents-type-test-"));
  const project = join(dir, "project");
  await mkdir(project);
  await mkdir(join(project, "AGENTS.md"));
  const store = await ShellStore.open(dir, join(dir, "shells.db"));

  try {
    await assert.rejects(() => createShell(store, project), /AGENTS\.md is not a file/);
    await rm(join(project, "AGENTS.md"), { recursive: true });
    const first = await createShell(store, project);
    assert.equal(first.shellId, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("MCP create_shell feeds shell_id into relative file operations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-mcp-test-"));
  const project = join(dir, "project");
  await mkdir(project);
  await writeFile(join(project, "hello.txt"), "hello from shell\n", "utf8");

  const config: LocalAppConfig = {
    mode: "local",
    port: 0,
    commandPath: {
      userBinDir: join(dir, "user-bin"),
      repoBinDir: join(dir, "repo-bin"),
    },
    paths: {
      configDir: dir,
      envFile: join(dir, "env"),
      shellEnvFile: null,
      stateFile: join(dir, "state.json"),
      shellsDbFile: join(dir, "shells.db"),
      userBinDir: join(dir, "user-bin"),
      repoBinDir: join(dir, "repo-bin"),
    },
  };

  const runtime = await createApp(config);
  const server = await new Promise<Server>((resolve) => {
    const listening = runtime.app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address() as AddressInfo;
  const client = new Client({ name: "shell-integration-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));

  try {
    await client.connect(transport);
    const created = await client.callTool({ name: "create_shell", arguments: { cwd: project } });
    const shellId = (created.structuredContent as { shell_id?: unknown } | undefined)?.shell_id;
    assert.equal(typeof shellId, "number");

    const read = await client.callTool({
      name: "read",
      arguments: { shell_id: shellId, path: "hello.txt" },
    });
    const content = read.content as Array<{ type: string; text?: string }>;
    const text = content
      .filter((item) => item.type === "text")
      .map((item) => item.text ?? "")
      .join("\n");
    assert.match(text, /hello from shell/);
  } finally {
    await client.close().catch(() => {});
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
