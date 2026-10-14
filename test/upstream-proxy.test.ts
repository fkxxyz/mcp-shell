import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createApp } from "../src/http/app.js";
import { InvocationGate } from "../src/tools/invocation-gate.js";
import { UpstreamSet, registerUpstreamTools } from "../src/upstream/proxy.js";

type FakeUpstream = { url: URL; port: number; close(): Promise<void> };

function buildFakeServer(extraTools: string[] = []): McpServer {
  const server = new McpServer({ name: "fake-upstream", version: "0.0.1" });
  for (const name of extraTools) {
    server.registerTool(name, { description: "extra", inputSchema: {} }, async () => ({ content: [{ type: "text", text: name }] }));
  }
  server.registerTool("echo", {
    description: "Echo text back",
    inputSchema: { text: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ text }) => ({ content: [{ type: "text", text }] }));
  server.registerTool("fail", {
    description: "Return a tool error",
    inputSchema: {},
  }, async () => ({ content: [{ type: "text", text: "boom" }], isError: true }));
  server.registerTool("slow", {
    description: "Never answers in time",
    inputSchema: {},
  }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return { content: [{ type: "text", text: "late" }] };
  });
  server.registerTool("big", {
    description: "Return a large payload",
    inputSchema: {},
  }, async () => ({ content: [{ type: "text", text: "x".repeat(120 * 1024) }] }));
  return server;
}

async function startFakeUpstream(port = 0, extraTools: string[] = []): Promise<FakeUpstream> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const http: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const sessionId = req.headers["mcp-session-id"];
    let transport = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (!transport) {
      if (!isInitializeRequest(body)) {
        res.statusCode = 400;
        res.end();
        return;
      }
      const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, created);
        },
      });
      transport = created;
      await buildFakeServer(extraTools).connect(created);
    }
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => http.listen(port, "127.0.0.1", () => resolve()));
  const actual = (http.address() as AddressInfo).port;
  return {
    port: actual,
    url: new URL(`http://127.0.0.1:${actual}/mcp`),
    close: () => new Promise<void>((resolve) => {
      http.closeAllConnections();
      http.close(() => resolve());
    }),
  };
}

async function connectClient(upstreams: UpstreamSet, native: string[] = [], invocations = new InvocationGate()): Promise<Client> {
  const server = new McpServer({ name: "mcp-shell", version: "test" });
  for (const name of native) {
    server.registerTool(name, { description: "native", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "native" }] }));
  }
  registerUpstreamTools(server, upstreams, invocations);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
  return client;
}

function textOf(result: unknown): string {
  return ((result as { content: Array<{ type: string; text?: string }> }).content)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

test("proxied tools are listed with their schema and annotations and forwarded", async (t) => {
  const upstream = await startFakeUpstream();
  t.after(() => upstream.close());
  const set = await UpstreamSet.connect({ timeoutMs: 500, upstreams: [{ name: "fake", url: upstream.url }] });
  t.after(() => set.close());
  const client = await connectClient(set);
  t.after(() => client.close());

  const { tools } = await client.listTools();
  const echo = tools.find((tool) => tool.name === "echo");
  assert.ok(echo, "echo listed");
  assert.equal(echo.annotations?.readOnlyHint, true);
  assert.equal(echo.inputSchema.type, "object");
  assert.deepEqual(echo.inputSchema.required, ["text"]);

  const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });
  assert.equal(textOf(result), "hi");
  assert.notEqual(result.isError, true);
});

test("upstream tool errors pass through as isError results", async (t) => {
  const upstream = await startFakeUpstream();
  t.after(() => upstream.close());
  const set = await UpstreamSet.connect({ timeoutMs: 500, upstreams: [{ name: "fake", url: upstream.url }] });
  t.after(() => set.close());
  const client = await connectClient(set);
  t.after(() => client.close());

  const result = await client.callTool({ name: "fail", arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), "boom");
});

test("a slow upstream call times out without retrying", async (t) => {
  const upstream = await startFakeUpstream();
  t.after(() => upstream.close());
  const set = await UpstreamSet.connect({ timeoutMs: 300, upstreams: [{ name: "fake", url: upstream.url }] });
  t.after(() => set.close());
  const client = await connectClient(set);
  t.after(() => client.close());

  const result = await client.callTool({ name: "slow", arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), "upstream fake timed out");
});

test("oversized upstream text is truncated with a notice", async (t) => {
  const upstream = await startFakeUpstream();
  t.after(() => upstream.close());
  const set = await UpstreamSet.connect({ timeoutMs: 2_000, upstreams: [{ name: "fake", url: upstream.url }] });
  t.after(() => set.close());
  const client = await connectClient(set);
  t.after(() => client.close());

  const text = textOf(await client.callTool({ name: "big", arguments: {} }));
  assert.ok(Buffer.byteLength(text, "utf8") < 50 * 1024 + 200, "bounded near the 50KB limit");
  assert.match(text, /truncated by mcp-shell/);
});

test("reconnects on the next call after the upstream restarts, without replaying the failed call", async (t) => {
  const first = await startFakeUpstream();
  const set = await UpstreamSet.connect({ timeoutMs: 500, upstreams: [{ name: "fake", url: first.url }] });
  t.after(() => set.close());
  const client = await connectClient(set);
  t.after(() => client.close());

  await first.close();
  const down = await client.callTool({ name: "echo", arguments: { text: "a" } });
  assert.equal(down.isError, true);
  assert.equal(textOf(down), "upstream fake unavailable");

  const restarted = await startFakeUpstream(first.port);
  t.after(() => restarted.close());
  const up = await client.callTool({ name: "echo", arguments: { text: "b" } });
  assert.equal(up.isError, undefined);
  assert.equal(textOf(up), "b");
});

test("startup fails when an upstream is unreachable", async () => {
  const unused = await startFakeUpstream();
  const url = unused.url;
  await unused.close();
  await assert.rejects(
    UpstreamSet.connect({ timeoutMs: 500, upstreams: [{ name: "down", url }] }),
    /Upstream "down" failed at startup/,
  );
});

test("a proxied tool whose name matches a native tool fails registration", async (t) => {
  const upstream = await startFakeUpstream();
  t.after(() => upstream.close());
  const set = await UpstreamSet.connect({ timeoutMs: 500, upstreams: [{ name: "fake", url: upstream.url }] });
  t.after(() => set.close());

  await assert.rejects(
    connectClient(set, ["echo"]),
    /Upstream "fake" tool "echo" conflicts with an existing tool/,
  );
});

test("proxied calls are refused once the server stops accepting invocations", async (t) => {
  const upstream = await startFakeUpstream();
  t.after(() => upstream.close());
  const set = await UpstreamSet.connect({ timeoutMs: 500, upstreams: [{ name: "fake", url: upstream.url }] });
  t.after(() => set.close());
  const invocations = new InvocationGate();
  const client = await connectClient(set, [], invocations);
  t.after(() => client.close());

  invocations.close();
  const result = await client.callTool({ name: "echo", arguments: { text: "late" } });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), "Server is shutting down");
});

test("closing upstreams unblocks an in-flight proxied call during shutdown", async (t) => {
  const upstream = await startFakeUpstream();
  t.after(() => upstream.close());
  const set = await UpstreamSet.connect({ timeoutMs: 10_000, upstreams: [{ name: "fake", url: upstream.url }] });
  const invocations = new InvocationGate();
  const client = await connectClient(set, [], invocations);
  t.after(() => client.close());

  const started = Date.now();
  const pending = client.callTool({ name: "slow", arguments: {} });
  await new Promise((resolve) => setTimeout(resolve, 100));
  invocations.close();
  invocations.interruptCancellable();
  await set.close();
  const result = await pending;
  assert.equal(result.isError, true);
  assert.ok(Date.now() - started < 1_500, "in-flight call settled without waiting for the upstream");
});

test("createApp refuses to start when a proxied tool collides with a built-in tool", async (t) => {
  const upstream = await startFakeUpstream(0, ["bash"]);
  t.after(() => upstream.close());
  const configDir = await mkdtemp(join(tmpdir(), "mcp-shell-upstream-collision-"));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  await assert.rejects(
    createApp({
      mode: "local",
      port: 0,
      commandPath: { userBinDir: join(configDir, "user-bin"), repoBinDir: join(configDir, "repo-bin") },
      upstreams: { timeoutMs: 500, upstreams: [{ name: "fake", url: upstream.url }] },
      toolLogs: { dir: join(configDir, "tool-logs"), maxCalls: 100 },
      paths: {
        configDir,
        envFile: join(configDir, "env"),
        shellEnvFile: null,
        stateFile: join(configDir, "state.json"),
        shellsDbFile: join(configDir, "shells.db"),
        userBinDir: join(configDir, "user-bin"),
        repoBinDir: join(configDir, "repo-bin"),
      },
    }),
    /Upstream "fake" tool "bash" conflicts with an existing tool/,
  );
});
