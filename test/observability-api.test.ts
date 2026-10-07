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
const OBSERVABILITY_TOKEN = "observability-test-token";
const BASIC = "Basic " + Buffer.from("activity:" + WEB_PASSWORD).toString("base64");
const OBS_BEARER = "Bearer " + OBSERVABILITY_TOKEN;

test("local mode exposes headless observability API without enabling the Web Console", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-observability-local-"));
  const ctx = await listen(makeLocalConfig(dir));
  t.after(() => cleanup(ctx, dir));

  assert.equal((await fetch(ctx.baseUrl + "/")).status, 404);
  assert.equal((await fetch(ctx.baseUrl + "/console/")).status, 404);
  assert.equal((await fetch(ctx.baseUrl + "/api/activity")).status, 404, "unversioned API must stay absent");

  const activity = await fetch(ctx.baseUrl + "/api/v1/activity");
  assert.equal(activity.status, 200);
  const body = await activity.json();
  assert.equal(body.active_window_ms, 5 * 60 * 1000);
  assert.deepEqual(body.workspaces, []);
});

test("Web Console remains independently Basic-authenticated", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-observability-web-"));
  const ctx = await listen(makeLocalConfig(dir, WEB_PASSWORD));
  t.after(() => cleanup(ctx, dir));

  const root = await fetch(ctx.baseUrl + "/", { redirect: "manual" });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/console/");
  assert.equal(root.headers.get("cache-control"), "no-store");

  const anonymous = await fetch(ctx.baseUrl + "/console/");
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("www-authenticate") ?? "", /^Basic /);

  const page = await fetch(ctx.baseUrl + "/console/", { headers: { authorization: BASIC } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /mcp-shell/);
  assert.equal(page.headers.get("cache-control"), "no-store");

  const csp = page.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);

  const deepLink = await fetch(ctx.baseUrl + "/console/shells/42", { headers: { authorization: BASIC } });
  assert.equal(deepLink.status, 200);

  const asset = await fetch(ctx.baseUrl + "/console/assets/app-test.js", { headers: { authorization: BASIC } });
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("cache-control") ?? "", /immutable/);

  const missingAsset = await fetch(ctx.baseUrl + "/console/assets/missing.js", { headers: { authorization: BASIC } });
  assert.equal(missingAsset.status, 404);
});

test("remote observability API is absent without a read credential", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-observability-remote-disabled-"));
  const ctx = await listen(makeRemoteConfig(dir));
  t.after(() => cleanup(ctx, dir));

  assert.equal((await fetch(ctx.baseUrl + "/api/v1/activity")).status, 404);
});

test("remote observability API accepts its bearer token without enabling Web Console", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-observability-token-"));
  const ctx = await listen(makeRemoteConfig(dir, { observabilityToken: OBSERVABILITY_TOKEN }));
  t.after(() => cleanup(ctx, dir));

  assert.equal((await fetch(ctx.baseUrl + "/console/")).status, 404);

  const anonymous = await fetch(ctx.baseUrl + "/api/v1/activity");
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("www-authenticate") ?? "", /Bearer/);

  const wrong = await fetch(ctx.baseUrl + "/api/v1/activity", {
    headers: { authorization: "Bearer wrong" },
  });
  assert.equal(wrong.status, 401);

  const authorized = await fetch(ctx.baseUrl + "/api/v1/activity", {
    headers: { authorization: OBS_BEARER },
  });
  assert.equal(authorized.status, 200);
  assert.equal(authorized.headers.get("cache-control"), "no-store");
});

test("remote API accepts Web Basic when configured and both read credentials can coexist", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-observability-dual-auth-"));
  const ctx = await listen(makeRemoteConfig(dir, {
    webPassword: WEB_PASSWORD,
    observabilityToken: OBSERVABILITY_TOKEN,
  }));
  t.after(() => cleanup(ctx, dir));

  assert.equal((await fetch(ctx.baseUrl + "/api/v1/activity", {
    headers: { authorization: BASIC },
  })).status, 200);
  assert.equal((await fetch(ctx.baseUrl + "/api/v1/activity", {
    headers: { authorization: OBS_BEARER },
  })).status, 200);
});

test("MCP tool calls appear in v1 activity, Shell status, history, detail, and SSE", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-observability-e2e-"));
  const project = join(dir, "project");
  await mkdir(project);
  await writeFile(join(project, "hello.txt"), "hello activity\n", "utf8");

  const ctx = await listen(makeLocalConfig(dir));
  const client = new Client({ name: "activity-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(ctx.baseUrl + "/mcp"));
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

  const runningCall = client.callTool({
    name: "bash",
    arguments: { shell_id: shellId, command: "sleep 0.4" },
  });
  let runningActivity: any;
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch(ctx.baseUrl + "/api/v1/shells/" + shellId + "/activity");
    runningActivity = await response.json();
    if (runningActivity.running_call_count > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(runningActivity.active, true);
  assert.equal(runningActivity.running_call_count, 1);
  assert.equal(runningActivity.active_until, null);
  await runningCall;

  const shellActivityResponse = await fetch(ctx.baseUrl + "/api/v1/shells/" + shellId + "/activity");
  assert.equal(shellActivityResponse.status, 200);
  const shellActivity = await shellActivityResponse.json();
  assert.equal(shellActivity.shell_id, shellId);
  assert.equal(shellActivity.cwd, project);
  assert.equal(shellActivity.active, true);
  assert.equal(shellActivity.running_call_count, 0);
  assert.equal(shellActivity.active_window_ms, 5 * 60 * 1000);
  assert.ok(shellActivity.last_event_at);
  assert.ok(shellActivity.active_until);
  assert.ok(Date.parse(shellActivity.active_until) > Date.parse(shellActivity.last_event_at));
  assert.ok(shellActivity.server_time);

  const missing = await fetch(ctx.baseUrl + "/api/v1/shells/999999/activity");
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "shell_not_found");

  const snapshotResponse = await fetch(ctx.baseUrl + "/api/v1/activity");
  assert.equal(snapshotResponse.status, 200);
  const snapshot = await snapshotResponse.json();
  const workspace = snapshot.workspaces.find((item: any) => item.cwd === project);
  assert.ok(workspace);
  assert.equal(workspace.active, true);
  assert.ok(workspace.recent_shells.some((shell: any) => shell.shell_id === shellId && shell.active));

  const shellsResponse = await fetch(
    ctx.baseUrl + "/api/v1/shells?cwd=" + encodeURIComponent(project) + "&limit=1",
  );
  assert.equal(shellsResponse.status, 200);
  const shells = await shellsResponse.json();
  assert.equal(shells.items[0].shell_id, shellId);
  assert.ok(shells.items[0].last_activity_at);
  assert.notEqual(shells.next_cursor, String(shellId), "pagination cursors are opaque to clients");

  const callsResponse = await fetch(ctx.baseUrl + "/api/v1/shells/" + shellId + "/calls?limit=1");
  assert.equal(callsResponse.status, 200);
  const calls = await callsResponse.json();
  assert.ok(calls.next_cursor);

  const allCallsResponse = await fetch(ctx.baseUrl + "/api/v1/shells/" + shellId + "/calls");
  const allCalls = await allCallsResponse.json();
  assert.ok(allCalls.items.some((call: any) => call.tool === "create_shell"));
  const readCall = allCalls.items.find((call: any) => call.tool === "read");
  assert.ok(readCall);
  assert.equal(readCall.cwd, project);
  assert.deepEqual(readCall.input_preview, { shell_id: shellId, path: "hello.txt" });
  assert.equal(readCall.payload_available, true);

  const detailResponse = await fetch(ctx.baseUrl + "/api/v1/tool-calls/" + readCall.id);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.shell_id, shellId);
  assert.equal(detail.cwd, project);
  assert.equal(detail.input.path, "hello.txt");

  const controller = new AbortController();
  const streamResponse = await fetch(ctx.baseUrl + "/api/v1/activity/stream", {
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
  assert.ok(received.includes("input_preview"));
  assert.ok(received.includes('"active_window_ms"'));
  assert.ok(received.includes('"active_until"'));
  controller.abort();
  await reader.cancel().catch(() => {});
});

test("read-only credentials never authorize remote MCP", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-observability-mcp-isolation-"));
  const ctx = await listen(makeRemoteConfig(dir, {
    webPassword: WEB_PASSWORD,
    observabilityToken: OBSERVABILITY_TOKEN,
  }));
  t.after(() => cleanup(ctx, dir));

  for (const authorization of [BASIC, OBS_BEARER]) {
    const response = await fetch(ctx.baseUrl + "/mcp", {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer /);
  }
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

function makeRemoteConfig(
  configDir: string,
  options: { webPassword?: string; observabilityToken?: string } = {},
): RemoteAppConfig {
  const base = makeConfig();
  return {
    ...base,
    ...options,
    toolLogs: {
      dir: join(configDir, "tool-logs"),
      maxCalls: 10_000,
    },
    paths: {
      ...base.paths,
      configDir,
      envFile: join(configDir, "env"),
      stateFile: join(configDir, "state.json"),
      shellsDbFile: join(configDir, "shells.db"),
      userBinDir: join(configDir, "user-bin"),
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
    baseUrl: "http://127.0.0.1:" + address.port,
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
