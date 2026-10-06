import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { LocalAppConfig, RemoteAppConfig } from "../src/config.js";
import { createApp, type AppRuntime } from "../src/http/app.js";
import { makeConfig } from "./helpers.js";

const WEB_PASSWORD = "web-test-password";
const BASIC = `Basic ${Buffer.from(`activity:${WEB_PASSWORD}`).toString("base64")}`;

test("Web Console and API are absent unless WEB_PASSWORD is configured", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-activity-disabled-"));
  const ctx = await listen(makeLocalConfig(dir));
  t.after(() => cleanup(ctx, dir));

  assert.equal((await fetch(`${ctx.baseUrl}/console/`)).status, 404);
  assert.equal((await fetch(`${ctx.baseUrl}/api/shells?cwd=/tmp`)).status, 404);
});

test("Web Console and API share one Basic Auth boundary with scoped caching", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-activity-auth-"));
  const ctx = await listen(makeLocalConfig(dir, WEB_PASSWORD));
  t.after(() => cleanup(ctx, dir));

  const anonymous = await fetch(`${ctx.baseUrl}/console/`);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("www-authenticate") ?? "", /^Basic /);

  const wrong = await fetch(`${ctx.baseUrl}/console/`, {
    headers: { authorization: `Basic ${Buffer.from("activity:wrong").toString("base64")}` },
  });
  assert.equal(wrong.status, 401);

  const page = await fetch(`${ctx.baseUrl}/console/`, {
    headers: { authorization: BASIC },
  });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /mcp-shell/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  const csp = page.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);

  const deepLink = await fetch(`${ctx.baseUrl}/console/shells/42`, { headers: { authorization: BASIC } });
  assert.equal(deepLink.status, 200);
  assert.match(await deepLink.text(), /mcp-shell/);

  const asset = await fetch(`${ctx.baseUrl}/console/assets/app-test.js`, { headers: { authorization: BASIC } });
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("cache-control") ?? "", /immutable/);

  const missingAsset = await fetch(`${ctx.baseUrl}/console/assets/missing.js`, { headers: { authorization: BASIC } });
  assert.equal(missingAsset.status, 404, "missing hashed assets must not fall back to index.html");

  const api = await fetch(`${ctx.baseUrl}/api/shells?cwd=${encodeURIComponent("/tmp/none")}`, {
    headers: { authorization: BASIC },
  });
  assert.equal(api.status, 200);
  assert.equal(api.headers.get("cache-control"), "no-store");
  assert.deepEqual((await api.json()).items, []);
});

test("MCP tool calls appear in activity history, detail, and SSE snapshot", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-activity-e2e-"));
  const project = join(dir, "project");
  await mkdir(project);
  await writeFile(join(project, "hello.txt"), "hello activity\n", "utf8");

  const ctx = await listen(makeLocalConfig(dir, WEB_PASSWORD));

  const client = new Client({ name: "activity-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${ctx.baseUrl}/mcp`));
  t.after(async () => {
    await client.close().catch(() => {});
    await cleanup(ctx, dir);
  });

  await client.connect(transport);
  const created = await client.callTool({ name: "create_shell", arguments: { cwd: project } });
  const shellId = Number((created.structuredContent as { shell_id?: unknown } | undefined)?.shell_id);
  assert.ok(Number.isInteger(shellId) && shellId > 0);

  await client.callTool({
    name: "read",
    arguments: { shell_id: shellId, path: "hello.txt" },
  });

  const shellsResponse = await fetch(
    `${ctx.baseUrl}/api/shells?cwd=${encodeURIComponent(project)}&limit=1`,
    { headers: { authorization: BASIC } },
  );
  assert.equal(shellsResponse.status, 200);
  const shells = await shellsResponse.json();
  assert.equal(shells.items[0].shell_id, shellId);
  assert.notEqual(shells.next_cursor, String(shellId), "pagination cursors are opaque to clients");

  const callsResponse = await fetch(
    `${ctx.baseUrl}/api/shells/${shellId}/calls?limit=1`,
    { headers: { authorization: BASIC } },
  );
  assert.equal(callsResponse.status, 200);
  const calls = await callsResponse.json();
  assert.ok(calls.next_cursor);

  const allCallsResponse = await fetch(
    `${ctx.baseUrl}/api/shells/${shellId}/calls`,
    { headers: { authorization: BASIC } },
  );
  const allCalls = await allCallsResponse.json();
  assert.ok(allCalls.items.some((call: any) => call.tool === "create_shell"));
  const readCall = allCalls.items.find((call: any) => call.tool === "read");
  assert.ok(readCall);
  assert.equal(readCall.cwd, project);
  assert.equal(readCall.payload_available, true);

  const detailResponse = await fetch(
    `${ctx.baseUrl}/api/tool-calls/${readCall.id}`,
    { headers: { authorization: BASIC } },
  );
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.shell_id, shellId);
  assert.equal(detail.cwd, project);
  assert.equal(detail.input.path, "hello.txt");

  const controller = new AbortController();
  const streamResponse = await fetch(`${ctx.baseUrl}/api/activity/stream`, {
    headers: { authorization: BASIC },
    signal: controller.signal,
  });
  assert.equal(streamResponse.status, 200);
  assert.match(streamResponse.headers.get("content-type") ?? "", /^text\/event-stream/);

  const reader = streamResponse.body!.getReader();
  let received = "";
  while (!received.includes("\n\n")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += Buffer.from(chunk.value).toString("utf8");
  }
  assert.match(received, /event: snapshot/);
  assert.ok(received.includes(project));
  controller.abort();
  await reader.cancel().catch(() => {});
});

test("Web Basic credentials never authorize remote /mcp", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-activity-remote-"));
  const base = makeConfig();
  const config: RemoteAppConfig = {
    ...base,
    webPassword: WEB_PASSWORD,
    toolLogs: {
      dir: join(dir, "tool-logs"),
      maxCalls: 10_000,
    },
    paths: {
      ...base.paths,
      configDir: dir,
      stateFile: join(dir, "state.json"),
      shellsDbFile: join(dir, "shells.db"),
    },
  };

  const ctx = await listen(config);
  t.after(() => cleanup(ctx, dir));

  const response = await fetch(`${ctx.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: BASIC,
      "content-type": "application/json",
    },
    body: "{}",
  });

  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer /);
});

function makeLocalConfig(configDir: string, webPassword?: string): LocalAppConfig {
  return {
    mode: "local",
    port: 0,
    webPassword,
    commandPath: {
      userBinDir: join(configDir, "user-bin"),
      repoBinDir: join(configDir, "repo-bin"),
    },
    toolLogs: {
      dir: join(configDir, "tool-logs"),
      maxCalls: 10_000,
    },
    paths: {
      configDir,
      envFile: join(configDir, "env"),
      shellEnvFile: null,
      stateFile: join(configDir, "state.json"),
      shellsDbFile: join(configDir, "shells.db"),
      userBinDir: join(configDir, "user-bin"),
      repoBinDir: join(configDir, "repo-bin"),
    },
  };
}

async function listen(config: LocalAppConfig | RemoteAppConfig) {
  const webRoot = join(config.paths.configDir, "web-fixture");
  await mkdir(join(webRoot, "assets"), { recursive: true });
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>mcp-shell</title><div id=\"root\"></div>", "utf8");
  await writeFile(join(webRoot, "assets", "app-test.js"), "export {};\n", "utf8");
  const runtime = await createApp(config, { webRoot });
  const server = await new Promise<Server>((resolve) => {
    const listening = runtime.app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address() as AddressInfo;
  return {
    runtime,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function cleanup(
  context: { runtime: AppRuntime; server: Server },
  dir: string,
): Promise<void> {
  await new Promise<void>((resolve) => context.server.close(() => resolve()));
  await context.runtime.close();
  await rm(dir, { recursive: true, force: true });
}
