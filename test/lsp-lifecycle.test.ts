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
import { SkillCatalog } from "../src/skills.js";
import { LSPServerManager } from "../src/tools/lsp.js";

class RecordingLspManager extends LSPServerManager {
  getClientCalls = 0;
  releaseClientCalls = 0;
  closeCalls = 0;

  private readonly fakeClient = {
    async documentSymbols() {
      return [];
    },
  };

  override async getClient(_root: string, _server: any, _commandPath: any): Promise<any> {
    this.getClientCalls++;
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
  const projectBin = join(project, "node_modules", ".bin");
  await mkdir(projectBin, { recursive: true });
  await writeFile(join(project, "package.json"), "{}\n");
  await writeFile(join(project, "example.ts"), "const symbol = 1;\n");
  await writeFile(join(projectBin, "typescript-language-server"), "");

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
