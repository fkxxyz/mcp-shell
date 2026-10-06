import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { LocalAppConfig } from "../src/config.js";
import { createApp } from "../src/http/app.js";
import { SkillCatalog } from "../src/skills.js";
import { LSPServerManager } from "../src/tools/lsp.js";

class RecordingLspManager extends LSPServerManager {
  getClientCalls = 0;
  releaseClientCalls = 0;
  closeCalls = 0;
  launches: Array<{ cwd: string; executable: string; args: string[]; env: NodeJS.ProcessEnv }> = [];

  private readonly fakeClient = {
    async documentSymbols() {
      return [];
    },
  };

  override async getClient(_server: any, launch: any): Promise<any> {
    this.getClientCalls++;
    this.launches.push(launch);
    return this.fakeClient;
  }

  override releaseClient(_root: string, _serverId: string): void {
    this.releaseClientCalls++;
  }

  override close(): Promise<void> {
    this.closeCalls++;
    return super.close();
  }
}

function makeLocalConfig(dir: string): LocalAppConfig {
  return {
    mode: "local",
    port: 0,
    commandPath: {
      userBinDir: join(dir, "user-bin"),
      repoBinDir: join(dir, "repo-bin"),
    },
    toolLogs: {
      dir: join(dir, "tool-logs"),
      maxCalls: 100,
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
}

function isolatedSkills(dir: string): SkillCatalog {
  return new SkillCatalog({ root: join(dir, "skills") });
}

async function listen(runtime: Awaited<ReturnType<typeof createApp>>): Promise<{ server: Server; baseUrl: string }> {
  const server = await new Promise<Server>((resolve) => {
    const listening = runtime.app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("each application runtime owns and closes only its LSP manager", async () => {
  const dirA = await mkdtemp(join(tmpdir(), "mcp-shell-lsp-app-a-"));
  const dirB = await mkdtemp(join(tmpdir(), "mcp-shell-lsp-app-b-"));
  const managerA = new RecordingLspManager();
  const managerB = new RecordingLspManager();
  const runtimeA = await createApp(makeLocalConfig(dirA), {
    skills: isolatedSkills(dirA),
    lspManager: managerA,
  });
  const runtimeB = await createApp(makeLocalConfig(dirB), {
    skills: isolatedSkills(dirB),
    lspManager: managerB,
  });

  try {
    await runtimeA.close();
    assert.equal(managerA.closeCalls, 1);
    assert.equal(managerB.closeCalls, 0);

    await runtimeA.close();
    assert.equal(managerA.closeCalls, 1, "AppRuntime.close must remain idempotent");

    await runtimeB.close();
    assert.equal(managerB.closeCalls, 1);
  } finally {
    await runtimeA.close().catch(() => {});
    await runtimeB.close().catch(() => {});
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test("MCP sessions share the application-scoped LSP manager", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-lsp-shared-"));
  const project = join(dir, "project");
  const projectConfig = join(project, ".pi");
  const userBin = join(dir, "user-bin");
  const pinnedExecutable = join(userBin, "mcp-shell-test-language-server");
  await mkdir(projectConfig, { recursive: true });
  await mkdir(userBin, { recursive: true });
  await writeFile(join(project, "package.json"), "{}\n");
  await writeFile(join(project, "example.ts"), "const symbol = 1;\n");
  await writeFile(pinnedExecutable, "#!/bin/sh\n");
  await chmod(pinnedExecutable, 0o755);
  await writeFile(join(projectConfig, "lsp-tools.json"), JSON.stringify({
    lsp: {
      pinned: {
        command: ["mcp-shell-test-language-server", "--stdio"],
        extensions: [".ts"],
      },
    },
  }));

  const manager = new RecordingLspManager();
  const runtime = await createApp(makeLocalConfig(dir), {
    skills: isolatedSkills(dir),
    lspManager: manager,
  });
  const { server, baseUrl } = await listen(runtime);
  const clientA = new Client({ name: "lsp-session-a", version: "1.0.0" });
  const clientB = new Client({ name: "lsp-session-b", version: "1.0.0" });

  try {
    await clientA.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    await clientB.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));

    const created = await clientA.callTool({ name: "create_shell", arguments: { cwd: project } });
    const shellId = (created.structuredContent as { shell_id?: unknown } | undefined)?.shell_id;
    assert.equal(typeof shellId, "number");

    for (const client of [clientA, clientB]) {
      const result = await client.callTool({
        name: "lsp_symbols",
        arguments: {
          shell_id: shellId,
          filePath: "example.ts",
          scope: "document",
        },
      });
      const text = (result.content as Array<{ type: string; text?: string }>)
        .filter((item) => item.type === "text")
        .map((item) => item.text ?? "")
        .join("\n");
      assert.match(text, /No symbols found/);
    }

    assert.equal(manager.getClientCalls, 2);
    assert.equal(manager.releaseClientCalls, 2);
    assert.equal(manager.closeCalls, 0);
  } finally {
    await clientA.close().catch(() => {});
    await clientB.close().catch(() => {});
    await closeServer(server);
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }

  assert.equal(manager.closeCalls, 1);
});

test("LSP selection resolves executables from the effective launch environment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-lsp-resolution-"));
  const project = join(dir, "project");
  const projectConfig = join(project, ".pi");
  const userBin = join(dir, "user-bin");
  const envBin = join(dir, "env-bin");
  const toolsDir = join(project, "tools");
  const pinnedExecutable = join(userBin, "mcp-shell-test-language-server");
  const envExecutable = join(envBin, "mcp-shell-env-language-server");
  const relativeExecutable = join(toolsDir, "relative-language-server");
  await mkdir(projectConfig, { recursive: true });
  await mkdir(userBin, { recursive: true });
  await mkdir(envBin, { recursive: true });
  await mkdir(toolsDir, { recursive: true });
  await writeFile(join(project, "package.json"), "{}\n");
  await writeFile(join(project, "example.ts"), "const symbol = 1;\n");
  await writeFile(join(project, "example.foo"), "symbol\n");
  await writeFile(join(project, "example.bar"), "symbol\n");
  for (const executable of [pinnedExecutable, envExecutable, relativeExecutable]) {
    await writeFile(executable, "#!/bin/sh\n");
    await chmod(executable, 0o755);
  }
  await writeFile(join(projectConfig, "lsp-tools.json"), JSON.stringify({
    lsp: {
      pinned: {
        command: ["mcp-shell-test-language-server", "--stdio"],
        extensions: [".ts"],
      },
      env: {
        command: ["mcp-shell-env-language-server", "--stdio"],
        extensions: [".foo"],
        env: { PATH: envBin },
      },
      relative: {
        command: ["./tools/relative-language-server", "--stdio"],
        extensions: [".bar"],
      },
    },
  }));

  const manager = new RecordingLspManager();
  const runtime = await createApp(makeLocalConfig(dir), {
    skills: isolatedSkills(dir),
    lspManager: manager,
  });
  const { server, baseUrl } = await listen(runtime);
  const client = new Client({ name: "lsp-resolution", version: "1.0.0" });

  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    const created = await client.callTool({ name: "create_shell", arguments: { cwd: project } });
    const shellId = (created.structuredContent as { shell_id?: unknown } | undefined)?.shell_id;
    assert.equal(typeof shellId, "number");

    for (const filePath of ["example.ts", "example.foo", "example.bar"]) {
      const result = await client.callTool({
        name: "lsp_symbols",
        arguments: {
          shell_id: shellId,
          filePath,
          scope: "document",
        },
      });
      const text = (result.content as Array<{ type: string; text?: string }>)
        .filter((item) => item.type === "text")
        .map((item) => item.text ?? "")
        .join("\n");
      assert.match(text, /No symbols found/);
    }

    assert.equal(manager.getClientCalls, 3);
    assert.equal(manager.releaseClientCalls, 3);
    assert.equal(manager.launches[0]?.cwd, project);
    assert.equal(manager.launches[0]?.executable, pinnedExecutable);
    assert.deepEqual(manager.launches[0]?.args, ["--stdio"]);
    assert.equal(manager.launches[1]?.executable, envExecutable);
    assert.equal(manager.launches[2]?.executable, relativeExecutable);
  } finally {
    await client.close().catch(() => {});
    await closeServer(server);
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
