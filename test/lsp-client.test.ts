import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { LspClient, type Diagnostic } from "../src/lsp/client.js";
import type {
  LspCloseOptions,
  LspConnection,
  LspLaunchSpec,
  LspNotificationHandler,
  LspRequestHandler,
  LspRequestOptions,
} from "../src/lsp/connection.js";

type TraceEntry = {
  kind: "request" | "notification";
  method: string;
  params?: unknown;
  options?: LspRequestOptions;
};

class FakeConnection implements LspConnection {
  readonly trace: TraceEntry[] = [];
  onSendNotification?: (method: string, params: unknown) => void;
  closedWith: LspCloseOptions | undefined;

  private alive = false;
  private readonly responses = new Map<string, (params: unknown) => unknown | Promise<unknown>>();
  private readonly requestHandlers = new Map<string, LspRequestHandler>();
  private readonly notificationHandlers = new Map<string, Set<LspNotificationHandler>>();
  private readonly closeHandlers = new Set<(error: Error) => void>();

  respond(method: string, handler: (params: unknown) => unknown | Promise<unknown>): void {
    this.responses.set(method, handler);
  }

  async start(): Promise<void> {
    this.alive = true;
  }

  async sendRequest<T>(method: string, params?: unknown, options?: LspRequestOptions): Promise<T> {
    this.trace.push({ kind: "request", method, params, options });
    const handler = this.responses.get(method);
    if (!handler) throw new Error(`No fake response for ${method}`);
    return await handler(params) as T;
  }

  sendNotification(method: string, params?: unknown): void {
    if (!this.alive) return;
    this.trace.push({ kind: "notification", method, params });
    this.onSendNotification?.(method, params);
  }

  onRequest(method: string, handler: LspRequestHandler): () => void {
    this.requestHandlers.set(method, handler);
    return () => {
      if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method);
    };
  }

  onNotification(method: string, handler: LspNotificationHandler): () => void {
    const handlers = this.notificationHandlers.get(method) ?? new Set<LspNotificationHandler>();
    handlers.add(handler);
    this.notificationHandlers.set(method, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.notificationHandlers.delete(method);
    };
  }

  onClose(handler: (error: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  isAlive(): boolean {
    return this.alive;
  }

  async close(options?: LspCloseOptions): Promise<void> {
    this.closedWith = options;
    if (!this.alive) return;
    this.alive = false;
    const error = new Error("fake connection closed");
    for (const handler of [...this.closeHandlers]) handler(error);
  }

  emitNotification(method: string, params: unknown): void {
    for (const handler of this.notificationHandlers.get(method) ?? []) {
      handler(params);
    }
  }
}

function launchFor(cwd: string): LspLaunchSpec {
  return {
    cwd,
    env: process.env,
    executable: process.execPath,
    args: [],
  };
}

async function makeProject(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-lsp-client-"));
  const file = join(dir, "example.ts");
  await writeFile(file, "const value = 1;\n");
  return { dir, file };
}

async function initializedClient(
  dir: string,
  connection: FakeConnection,
  capabilities: Record<string, unknown>,
): Promise<LspClient> {
  connection.respond("initialize", () => ({ capabilities }));
  connection.respond("shutdown", () => null);
  const client = new LspClient({
    serverId: "fake",
    languageIdForPath: () => "typescript",
    pushDiagnosticsDeadlineMs: 100,
  }, launchFor(dir), connection);
  await client.start();
  await client.initialize();
  return client;
}

function diagnostic(message: string): Diagnostic {
  return {
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    },
    severity: 1,
    message,
  };
}

test("initialize advertises only implemented LSP client capabilities", async () => {
  const { dir } = await makeProject();
  const connection = new FakeConnection();
  const client = await initializedClient(dir, connection, {});

  try {
    const initialize = connection.trace.find(
      (entry) => entry.kind === "request" && entry.method === "initialize",
    );
    assert.ok(initialize);

    const capabilities = (initialize.params as any).capabilities;
    assert.equal(capabilities.textDocument.publishDiagnostics.versionSupport, true);
    assert.equal(capabilities.textDocument.diagnostic.dynamicRegistration, false);
    assert.equal("hover" in capabilities.textDocument, false);
    assert.equal("codeAction" in capabilities.textDocument, false);
    assert.deepEqual(capabilities.workspace, {
      symbol: {},
      configuration: true,
    });
    assert.equal("applyEdit" in capabilities.workspace, false);
    assert.equal("workspaceFolders" in capabilities.workspace, false);

    assert.deepEqual(
      connection.trace
        .filter((entry) => entry.kind === "notification")
        .map((entry) => entry.method),
      ["initialized", "workspace/didChangeConfiguration"],
    );
  } finally {
    await client.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("stop performs LSP shutdown request before exit and grants natural-exit grace once", async () => {
  const { dir } = await makeProject();
  const connection = new FakeConnection();
  const client = await initializedClient(dir, connection, {});

  try {
    connection.trace.length = 0;
    await Promise.all([client.stop(), client.stop()]);

    assert.deepEqual(
      connection.trace.map((entry) => [entry.kind, entry.method]),
      [
        ["request", "shutdown"],
        ["notification", "exit"],
      ],
    );
    const shutdown = connection.trace[0];
    assert.equal(shutdown?.options?.timeoutMs, 1_000);
    assert.equal(connection.closedWith?.gracefulExitMs, 1_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stop falls back to process close without exit when shutdown request fails", async () => {
  const { dir } = await makeProject();
  const connection = new FakeConnection();
  const client = await initializedClient(dir, connection, {});
  connection.respond("shutdown", () => {
    throw new Error("shutdown failed");
  });

  try {
    connection.trace.length = 0;
    await client.stop();

    assert.deepEqual(
      connection.trace.map((entry) => [entry.kind, entry.method]),
      [["request", "shutdown"]],
    );
    assert.equal(connection.closedWith?.gracefulExitMs, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("document request follows didOpen without a readiness timer", async () => {
  const { dir, file } = await makeProject();
  const connection = new FakeConnection();
  connection.respond("textDocument/definition", () => null);
  const client = await initializedClient(dir, connection, { definitionProvider: true });

  try {
    connection.trace.length = 0;
    await client.definition(file, 1, 0);

    assert.deepEqual(
      connection.trace.map((entry) => [entry.kind, entry.method]),
      [
        ["notification", "textDocument/didOpen"],
        ["request", "textDocument/definition"],
      ],
    );
  } finally {
    await client.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("optional LSP feature fails from server capabilities before document sync", async () => {
  const { dir, file } = await makeProject();
  const connection = new FakeConnection();
  const client = await initializedClient(dir, connection, {});

  try {
    connection.trace.length = 0;
    await assert.rejects(
      client.definition(file, 1, 0),
      /does not advertise go-to-definition support/,
    );
    assert.deepEqual(connection.trace, []);
  } finally {
    await client.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("pull diagnostics uses diagnosticProvider and reuses previous result ids", async () => {
  const { dir, file } = await makeProject();
  const connection = new FakeConnection();
  const first = diagnostic("first");
  let pulls = 0;

  connection.respond("textDocument/diagnostic", () => {
    pulls++;
    if (pulls === 1) return { kind: "full", resultId: "r1", items: [first] };
    return { kind: "unchanged", resultId: "r2" };
  });

  const client = await initializedClient(dir, connection, {
    diagnosticProvider: {
      identifier: "fake-diagnostics",
      interFileDependencies: false,
      workspaceDiagnostics: false,
    },
  });

  try {
    connection.trace.length = 0;
    assert.deepEqual((await client.diagnostics(file)).items, [first]);
    assert.deepEqual((await client.diagnostics(file)).items, [first]);

    const requests = connection.trace.filter(
      (entry) => entry.kind === "request" && entry.method === "textDocument/diagnostic",
    );
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0]?.params, {
      textDocument: { uri: pathToFileURL(file).href },
      identifier: "fake-diagnostics",
    });
    assert.deepEqual(requests[1]?.params, {
      textDocument: { uri: pathToFileURL(file).href },
      identifier: "fake-diagnostics",
      previousResultId: "r1",
    });
  } finally {
    await client.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("push diagnostics handles publication racing with didOpen without pull probing", async () => {
  const { dir, file } = await makeProject();
  const connection = new FakeConnection();
  const client = await initializedClient(dir, connection, {});

  try {
    connection.trace.length = 0;
    connection.onSendNotification = (method, params) => {
      if (method !== "textDocument/didOpen") return;
      const uri = (params as any).textDocument.uri;
      connection.emitNotification("textDocument/publishDiagnostics", {
        uri,
        version: 1,
        diagnostics: [],
      });
    };

    assert.deepEqual((await client.diagnostics(file)).items, []);
    assert.equal(
      connection.trace.some(
        (entry) => entry.kind === "request" && entry.method === "textDocument/diagnostic",
      ),
      false,
    );
  } finally {
    await client.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("push diagnostics ignores stale versions after document change", async () => {
  const { dir, file } = await makeProject();
  const connection = new FakeConnection();
  const initial = diagnostic("initial");
  const current = diagnostic("current");
  const client = await initializedClient(dir, connection, {});

  try {
    connection.onSendNotification = (method, params) => {
      if (method === "textDocument/didOpen") {
        connection.emitNotification("textDocument/publishDiagnostics", {
          uri: (params as any).textDocument.uri,
          version: 1,
          diagnostics: [initial],
        });
      }
    };
    assert.deepEqual((await client.diagnostics(file)).items, [initial]);

    await writeFile(file, "const value = 2;\n");
    connection.onSendNotification = (method, params) => {
      if (method !== "textDocument/didChange") return;
      const uri = (params as any).textDocument.uri;
      connection.emitNotification("textDocument/publishDiagnostics", {
        uri,
        version: 1,
        diagnostics: [diagnostic("stale")],
      });
      connection.emitNotification("textDocument/publishDiagnostics", {
        uri,
        version: 2,
        diagnostics: [current],
      });
    };

    assert.deepEqual((await client.diagnostics(file)).items, [current]);
  } finally {
    await client.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("push diagnostics waits for a later publication without timing padding", async () => {
  const { dir, file } = await makeProject();
  const connection = new FakeConnection();
  const client = await initializedClient(dir, connection, {});

  try {
    const pending = client.diagnostics(file);
    await Promise.resolve();

    connection.emitNotification("textDocument/publishDiagnostics", {
      uri: pathToFileURL(file).href,
      version: 1,
      diagnostics: [diagnostic("delayed")],
    });

    assert.deepEqual((await pending).items, [diagnostic("delayed")]);
  } finally {
    await client.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("push diagnostics wait is abortable", async () => {
  const { dir, file } = await makeProject();
  const connection = new FakeConnection();
  const client = await initializedClient(dir, connection, {});
  const controller = new AbortController();

  try {
    const pending = client.diagnostics(file, controller.signal);
    controller.abort();
    await assert.rejects(pending, /diagnostics aborted/);
  } finally {
    await client.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
