import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Request } from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { LocalAppConfig } from "../src/config.js";
import { createApp } from "../src/http/app.js";
import { resolveClientIdentity } from "../src/mcp/client-identity.js";

function request(headers: Record<string, string | string[] | undefined>, body: unknown): Pick<Request, "headers" | "body"> {
  return { headers, body } as Pick<Request, "headers" | "body">;
}

test("standard MCP client names and vendor logical sessions are independent", () => {
  const meta = { method: "tools/call", params: { _meta: { "openai/session": "meta-session" } } };
  assert.deepEqual(resolveClientIdentity("generic-client", request({}, meta)), {
    clientName: "generic-client",
    clientSessionId: "openai:meta-session",
  });
  assert.deepEqual(resolveClientIdentity("ChatGPT", request({ "x-openai-session": "meta-session" }, meta)), {
    clientName: "ChatGPT",
    clientSessionId: "openai:meta-session",
  });
  assert.deepEqual(resolveClientIdentity("other-client", request({}, { method: "tools/call" })), {
    clientName: "other-client",
    clientSessionId: undefined,
  });
  assert.equal(resolveClientIdentity(undefined, request({}, meta)).clientName, undefined);
});

test("OpenAI _meta is canonical, with header fallback for missing or invalid metadata", () => {
  const meta = { method: "tools/call", params: { _meta: { "openai/session": "canonical" } } };
  assert.equal(resolveClientIdentity("ChatGPT", request({}, meta)).clientSessionId, "openai:canonical");
  assert.equal(resolveClientIdentity("ChatGPT", request({ "x-openai-session": "canonical" }, meta)).clientSessionId, "openai:canonical");
  assert.equal(resolveClientIdentity("ChatGPT", request({ "x-openai-session": "fallback" }, {
    method: "tools/call", params: { _meta: { "openai/session": " invalid" } },
  })).clientSessionId, "openai:fallback");
  assert.equal(resolveClientIdentity("ChatGPT", request({ "x-openai-session": "fallback" }, {
    method: "tools/call", params: { _meta: { "openai/session": 42 } },
  })).clientSessionId, "openai:fallback");
  assert.equal(resolveClientIdentity("ChatGPT", request({ "x-openai-session": "fallback" }, {
    method: "tools/call", params: { _meta: null },
  })).clientSessionId, "openai:fallback");
  assert.equal(resolveClientIdentity("ChatGPT", request({ "x-openai-session": "fallback" }, {
    method: "tools/call", params: {}, _meta: { "openai/session": "wrong-level" },
  })).clientSessionId, "openai:fallback");
});

test("conflicting valid hints prefer _meta and only emit a redacted warning", () => {
  const warnings: string[] = [];
  const previousWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    const meta = { method: "tools/call", params: { _meta: { "openai/session": "private-meta-value" } } };
    const identity = resolveClientIdentity("ChatGPT", request({ "x-openai-session": "private-header-value" }, meta));
    assert.equal(identity.clientSessionId, "openai:private-meta-value");
    assert.equal(warnings.length, 1);
    assert.ok(warnings.every((warning) => !warning.includes("private-meta-value") && !warning.includes("private-header-value")));
  } finally {
    console.warn = previousWarn;
  }
});

test("malformed, oversized or ambiguous identity hints never invent sessions", () => {
  const body = { method: "tools/call", params: { _meta: { "openai/session": "" } } };
  for (const value of ["", " leading", "line\nbreak", "x".repeat(257)]) {
    assert.equal(resolveClientIdentity("client", request({ "x-openai-session": value }, body)).clientSessionId, undefined);
  }
  assert.equal(resolveClientIdentity("ignored", request({ "x-openai-session": ["a", "b"] }, body)).clientSessionId, undefined);
  assert.equal(resolveClientIdentity("ignored", request({}, { method: "tools/call", params: {
    _meta: { "openai/session": "x".repeat(257) },
  } })).clientSessionId, undefined);
  assert.equal(resolveClientIdentity("invalid\nclient", request({}, {})).clientName, undefined);
  assert.equal(resolveClientIdentity("client", request({ "x-openai-session": "header" }, [
    { method: "tools/call", params: { _meta: { "openai/session": "one" } } },
    { method: "tools/call", params: { _meta: { "openai/session": "two" } } },
  ])).clientSessionId, undefined);
});

test("HTTP MCP client identity survives reconnect and process restart without merging different clients", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-client-identity-"));
  const root = join(dir, "project");
  await mkdir(root);
  await writeFile(join(root, "hello.txt"), "hello\n");

  const config: LocalAppConfig = {
    mode: "local",
    port: 0,
    commandPath: { userBinDir: join(dir, "user-bin"), repoBinDir: join(dir, "repo-bin") },
    toolLogs: { dir: join(dir, "tool-logs"), maxCalls: 100 },
    paths: {
      configDir: dir, envFile: join(dir, "env"), shellEnvFile: null,
      stateFile: join(dir, "state.json"), shellsDbFile: join(dir, "shells.db"),
      userBinDir: join(dir, "user-bin"), repoBinDir: join(dir, "repo-bin"),
    },
  };

  let runtime = await createApp(config);
  let server = await new Promise<Server>((resolve) => {
    const listener = runtime.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  let baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function connect(name: string, logicalSession?: string): Promise<Client> {
    const client = new Client({ name, version: "1.0.0" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl + "/mcp"), {
      requestInit: logicalSession ? { headers: { "x-openai-session": logicalSession } } : undefined,
    }));
    return client;
  }

  const first = await connect("example-agent", "conversation-a");
  const created = await first.callTool({ name: "create_shell", arguments: { cwd: root } });
  const shellId = Number((created.structuredContent as { shell_id?: unknown })?.shell_id);
  assert.ok(shellId > 0);
  await first.callTool({ name: "read", arguments: { shell_id: shellId, path: "hello.txt" } });
  await first.close();

  const second = await connect("example-agent", "conversation-a");
  await second.callTool({ name: "read", arguments: { shell_id: shellId, path: "hello.txt" } });
  const third = await connect("other-agent", "conversation-b");
  await third.callTool({ name: "read", arguments: { shell_id: shellId, path: "hello.txt" },
    _meta: { "openai/session": "conversation-b-meta" } });
  const generic = await connect("generic-mcp-client");
  await generic.callTool({ name: "read", arguments: { shell_id: shellId, path: "hello.txt" },
    _meta: { "openai/session": "conversation-meta-only" } });

  const response = await fetch(baseUrl + `/api/v1/shells/${shellId}/calls`);
  assert.equal(response.status, 200);
  const history = await response.json() as { items: Array<{
    id: string; client_name: string | null; client_session_id: string | null;
  }> };
  assert.deepEqual(history.items.map(({ client_name, client_session_id }) => [client_name, client_session_id]), [
    ["generic-mcp-client", "openai:conversation-meta-only"],
    ["other-agent", "openai:conversation-b-meta"],
    ["example-agent", "openai:conversation-a"],
    ["example-agent", "openai:conversation-a"],
    ["example-agent", "openai:conversation-a"],
  ]);
  for (const item of history.items) {
    const detail = await (await fetch(baseUrl + `/api/v1/tool-calls/${item.id}`)).json();
    assert.equal(detail.client_name, item.client_name);
    assert.equal(detail.client_session_id ?? null, item.client_session_id);
  }
  const activity = await (await fetch(baseUrl + "/api/v1/activity")).json();
  const call = activity.workspaces.flatMap((w: { recent_calls: unknown[] }) => w.recent_calls);
  assert.deepEqual(call.slice(0, 5).map((v: any) => [v.client_name, v.client_session_id]), history.items.map((v) => [v.client_name, v.client_session_id]));

  // A process restart must not change the meaning of previously recorded
  // client-session identifiers, even though MCP transport sessions are lost.
  await Promise.all(clients.map((client) => client.close().catch(() => {})));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await runtime.close();
  runtime = await createApp(config);
  server = await new Promise<Server>((resolve) => {
    const listener = runtime.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const restarted = await connect("example-agent", "conversation-a");
  await restarted.callTool({ name: "read", arguments: { shell_id: shellId, path: "hello.txt" } });

  const afterRestartResponse = await fetch(baseUrl + `/api/v1/shells/${shellId}/calls`);
  assert.equal(afterRestartResponse.status, 200);
  const afterRestart = await afterRestartResponse.json() as {
    items: Array<{ client_name: string | null; client_session_id: string | null }>;
  };
  assert.equal(afterRestart.items.length, history.items.length + 1);
  assert.equal(afterRestart.items[0]?.client_name, "example-agent");
  assert.equal(afterRestart.items[0]?.client_session_id, "openai:conversation-a");
  assert.deepEqual(afterRestart.items.slice(1).map(({ client_name, client_session_id }) => [client_name, client_session_id]),
    history.items.map(({ client_name, client_session_id }) => [client_name, client_session_id]));
});
