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

const ACTIVITY_PASSWORD = "activity-test-password";
const BASIC = `Basic ${Buffer.from(`activity:${ACTIVITY_PASSWORD}`).toString("base64")}`;

test("activity surface is absent unless ACTIVITY_PASSWORD is configured", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-activity-disabled-"));
  const ctx = await listen(makeLocalConfig(dir));
  t.after(() => cleanup(ctx, dir));

  const response = await fetch(`${ctx.baseUrl}/activity/`);
  assert.equal(response.status, 404);
});

test("activity surface uses one Basic Auth boundary and security headers", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-activity-auth-"));
  const ctx = await listen(makeLocalConfig(dir, ACTIVITY_PASSWORD));
  t.after(() => cleanup(ctx, dir));

  const anonymous = await fetch(`${ctx.baseUrl}/activity/`);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("www-authenticate") ?? "", /^Basic /);

  const wrong = await fetch(`${ctx.baseUrl}/activity/`, {
    headers: { authorization: `Basic ${Buffer.from("activity:wrong").toString("base64")}` },
  });
  assert.equal(wrong.status, 401);

  const page = await fetch(`${ctx.baseUrl}/activity/`, {
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

  const api = await fetch(`${ctx.baseUrl}/activity/api/v1/shells?cwd=${encodeURIComponent("/tmp/none")}`, {
    headers: { authorization: BASIC },
  });
  assert.equal(api.status, 200);
  assert.deepEqual((await api.json()).items, []);
});

test("MCP tool calls appear in activity history, detail, and SSE snapshot", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-activity-e2e-"));
  const project = join(dir, "project");
  await mkdir(project);
  await writeFile(join(project, "hello.txt"), "hello activity\n", "utf8");

  const ctx = await listen(makeLocalConfig(dir, ACTIVITY_PASSWORD));

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
    `${ctx.baseUrl}/activity/api/v1/shells?cwd=${encodeURIComponent(project)}`,
    { headers: { authorization: BASIC } },
  );
  assert.equal(shellsResponse.status, 200);
  const shells = await shellsResponse.json();
  assert.equal(shells.items[0].shell_id, shellId);

  const callsResponse = await fetch(
    `${ctx.baseUrl}/activity/api/v1/shells/${shellId}/calls`,
    { headers: { authorization: BASIC } },
  );
  assert.equal(callsResponse.status, 200);
  const calls = await callsResponse.json();
  assert.ok(calls.items.some((call: any) => call.tool === "create_shell"));
  const readCall = calls.items.find((call: any) => call.tool === "read");
  assert.ok(readCall);
  assert.equal(readCall.cwd, project);
  assert.equal(readCall.payload_available, true);

  const detailResponse = await fetch(
    `${ctx.baseUrl}/activity/api/v1/tool-calls/${readCall.id}`,
    { headers: { authorization: BASIC } },
  );
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.shell_id, shellId);
  assert.equal(detail.cwd, project);
  assert.equal(detail.input.path, "hello.txt");

  const controller = new AbortController();
  const streamResponse = await fetch(`${ctx.baseUrl}/activity/api/v1/stream`, {
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

test("activity Basic credentials never authorize remote /mcp", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-activity-remote-"));
  const base = makeConfig();
  const config: RemoteAppConfig = {
    ...base,
    activityPassword: ACTIVITY_PASSWORD,
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

function makeLocalConfig(configDir: string, activityPassword?: string): LocalAppConfig {
  return {
    mode: "local",
    port: 0,
    activityPassword,
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
  const runtime = await createApp(config);
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
