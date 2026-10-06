import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type LspLaunchSpec = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  executable: string;
  args: string[];
};

export type LspRequestHandler = (params: unknown) => unknown | Promise<unknown>;
export type LspNotificationHandler = (params: unknown) => void;

export type LspRequestOptions = {
  timeoutMs?: number;
};

export type LspCloseOptions = {
  gracefulExitMs?: number;
};

export interface LspConnection {
  start(): Promise<void>;
  sendRequest<T>(method: string, params?: unknown, options?: LspRequestOptions): Promise<T>;
  sendNotification(method: string, params?: unknown): void;
  onRequest(method: string, handler: LspRequestHandler): () => void;
  onNotification(method: string, handler: LspNotificationHandler): () => void;
  onClose(handler: (error: Error) => void): () => void;
  isAlive(): boolean;
  close(options?: LspCloseOptions): Promise<void>;
}

type StreamReader = {
  read(): Promise<{ done: boolean; value: Uint8Array | undefined }>;
};

type UnifiedProcess = {
  stdin: { write(chunk: Uint8Array | string): void };
  stdout: { getReader(): StreamReader };
  stderr: { getReader(): StreamReader };
  exitCode: number | null;
  exited: Promise<number>;
  kill(signal?: string): void;
};

type JsonRpcRequestMessage = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
};

type JsonRpcNotificationMessage = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

type JsonRpcSuccessResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
};

type JsonRpcErrorResponse = {
  jsonrpc: "2.0";
  id: number | null;
  error: { code: number; message: string; data?: unknown };
};

type JsonRpcMessage =
  | JsonRpcRequestMessage
  | JsonRpcNotificationMessage
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

const REQUEST_TIMEOUT_MS = 15_000;
const STOP_GRACE_MS = 5_000;
const STOP_KILL_WAIT_MS = 1_000;
const LOG_FILE = join(tmpdir(), "pi-lsp-tools.log");

function log(message: string, data?: unknown): void {
  try {
    const line = `[${new Date().toISOString()}] ${message}${data === undefined ? "" : ` ${JSON.stringify(data)}`}\n`;
    appendFileSync(LOG_FILE, line);
  } catch {}
}

function validateCwd(cwd: string): { valid: boolean; error?: string } {
  try {
    if (!existsSync(cwd)) return { valid: false, error: `Working directory does not exist: ${cwd}` };
    const stats = statSync(cwd);
    if (!stats.isDirectory()) return { valid: false, error: `Path is not a directory: ${cwd}` };
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: `Cannot access working directory: ${cwd} (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

function wrapNodeProcess(proc: ChildProcess): UnifiedProcess {
  let resolveExited: (code: number) => void = () => {};
  let exitCode: number | null = null;
  const exited = new Promise<number>((resolvePromise) => {
    resolveExited = resolvePromise;
  });

  proc.on("exit", (code) => {
    exitCode = code ?? 1;
    resolveExited(exitCode);
  });
  proc.on("error", () => {
    if (exitCode === null) {
      exitCode = 1;
      resolveExited(1);
    }
  });

  const createStreamReader = (stream: NodeJS.ReadableStream | null): StreamReader => {
    const chunks: Uint8Array[] = [];
    let ended = false;
    let pendingResolve: ((value: { done: boolean; value: Uint8Array | undefined }) => void) | null = null;

    if (stream) {
      stream.on("data", (chunk: Buffer) => {
        const uint8 = new Uint8Array(chunk);
        if (pendingResolve) {
          const resolveNow = pendingResolve;
          pendingResolve = null;
          resolveNow({ done: false, value: uint8 });
        } else {
          chunks.push(uint8);
        }
      });
      stream.on("end", () => {
        ended = true;
        if (pendingResolve) {
          const resolveNow = pendingResolve;
          pendingResolve = null;
          resolveNow({ done: true, value: undefined });
        }
      });
      stream.on("error", () => {
        ended = true;
        if (pendingResolve) {
          const resolveNow = pendingResolve;
          pendingResolve = null;
          resolveNow({ done: true, value: undefined });
        }
      });
    } else {
      ended = true;
    }

    return {
      read() {
        return new Promise((resolvePromise) => {
          if (chunks.length > 0) {
            resolvePromise({ done: false, value: chunks.shift()! });
            return;
          }
          if (ended) {
            resolvePromise({ done: true, value: undefined });
            return;
          }
          pendingResolve = resolvePromise;
        });
      },
    };
  };

  return {
    stdin: {
      write(chunk: Uint8Array | string) {
        proc.stdin?.write(chunk);
      },
    },
    stdout: { getReader: () => createStreamReader(proc.stdout) },
    stderr: { getReader: () => createStreamReader(proc.stderr) },
    get exitCode() {
      return exitCode;
    },
    exited,
    kill(signal?: string) {
      try {
        proc.kill(signal === "SIGKILL" ? "SIGKILL" : undefined);
      } catch {}
    },
  };
}

function spawnProcess(launch: LspLaunchSpec): UnifiedProcess {
  const validation = validateCwd(launch.cwd);
  if (!validation.valid) {
    throw new Error(`[LSP] ${validation.error}`);
  }

  const proc = spawn(launch.executable, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: process.platform === "win32",
  });
  return wrapNodeProcess(proc);
}

export class StdioLspConnection implements LspConnection {
  private proc: UnifiedProcess | null = null;
  private readonly stderrBuffer: string[] = [];
  private readonly pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private readonly requestHandlers = new Map<string, LspRequestHandler>();
  private readonly notificationHandlers = new Map<string, Set<LspNotificationHandler>>();
  private readonly closeHandlers = new Set<(error: Error) => void>();
  private nextRequestID = 1;
  private readLoopStarted = false;
  private closed = false;

  constructor(
    private readonly launch: LspLaunchSpec,
    private readonly requestTimeoutMs = REQUEST_TIMEOUT_MS,
  ) {}

  async start(): Promise<void> {
    if (this.proc) throw new Error("LSP connection already started");

    const proc = spawnProcess(this.launch);
    this.proc = proc;
    this.startStderrReading();
    this.startReadLoop();

    void proc.exited.then((code) => {
      this.markClosed(new Error(`LSP server exited with code ${code}`));
    });
  }

  sendRequest<T>(method: string, params?: unknown, options: LspRequestOptions = {}): Promise<T> {
    const proc = this.proc;
    if (!proc) throw new Error("LSP client not started");
    if (this.closed || proc.exitCode !== null) {
      throw new Error(`LSP server already exited (code: ${proc.exitCode})`);
    }

    const id = this.nextRequestID++;
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        rejectPromise(new Error(`LSP request timeout (method: ${method})`));
      }, options.timeoutMs ?? this.requestTimeoutMs);

      this.pendingRequests.set(id, {
        resolve: (value) => resolvePromise(value as T),
        reject: rejectPromise,
        timeout,
      });

      try {
        this.sendRaw({
          jsonrpc: "2.0",
          id,
          method,
          ...(params === undefined ? {} : { params }),
        });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        rejectPromise(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  sendNotification(method: string, params?: unknown): void {
    if (!this.proc || this.closed || this.proc.exitCode !== null) return;
    this.sendRaw({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
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
    return this.proc !== null && !this.closed && this.proc.exitCode === null;
  }

  async close(options: LspCloseOptions = {}): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    this.markClosed(new Error("LSP client stopped"));

    if (!proc || proc.exitCode !== null) return;

    const gracefulExitMs = options.gracefulExitMs ?? 0;
    if (gracefulExitMs > 0) {
      let exitedNaturally = false;
      let timeoutID: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        proc.exited.then(() => {
          exitedNaturally = true;
        }).finally(() => {
          if (timeoutID) clearTimeout(timeoutID);
        }),
        new Promise<void>((resolvePromise) => {
          timeoutID = setTimeout(resolvePromise, gracefulExitMs);
        }),
      ]);
      if (exitedNaturally) return;
    }

    let exitedBeforeTimeout = false;
    try {
      proc.kill();
      let timeoutID: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        proc.exited.then(() => {
          exitedBeforeTimeout = true;
        }).finally(() => {
          if (timeoutID) clearTimeout(timeoutID);
        }),
        new Promise<void>((resolvePromise) => {
          timeoutID = setTimeout(resolvePromise, STOP_GRACE_MS);
        }),
      ]);
      if (!exitedBeforeTimeout) {
        try {
          proc.kill("SIGKILL");
          await Promise.race([
            proc.exited,
            new Promise<void>((resolvePromise) => setTimeout(resolvePromise, STOP_KILL_WAIT_MS)),
          ]);
        } catch {}
      }
    } catch {}
  }

  private startReadLoop(): void {
    if (!this.proc || this.readLoopStarted) return;
    this.readLoopStarted = true;

    const reader = this.proc.stdout.getReader();
    const loop = async () => {
      let buffer = Buffer.alloc(0);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          buffer = Buffer.concat([buffer, Buffer.from(value)]);

          while (true) {
            const headerEnd = buffer.indexOf("\r\n\r\n");
            if (headerEnd === -1) break;

            const headerText = buffer.slice(0, headerEnd).toString("utf-8");
            const match = headerText.match(/Content-Length:\s*(\d+)/i);
            if (!match) {
              buffer = buffer.slice(headerEnd + 4);
              continue;
            }

            const contentLength = Number(match[1]);
            const messageStart = headerEnd + 4;
            const messageEnd = messageStart + contentLength;
            if (buffer.length < messageEnd) break;

            const body = buffer.slice(messageStart, messageEnd).toString("utf-8");
            buffer = buffer.slice(messageEnd);

            try {
              this.handleMessage(JSON.parse(body) as JsonRpcMessage);
            } catch (error) {
              log("Failed to parse LSP message", {
                error: error instanceof Error ? error.message : String(error),
                body,
              });
            }
          }
        }
      } catch (error) {
        log("LSP stdout loop failed", error instanceof Error ? error.message : String(error));
      } finally {
        this.markClosed(new Error("LSP server connection closed"));
      }
    };

    void loop();
  }

  private handleMessage(message: JsonRpcMessage): void {
    if ("method" in message) {
      if ("id" in message) {
        void this.handleIncomingRequest(message);
      } else {
        const handlers = this.notificationHandlers.get(message.method);
        if (!handlers) return;
        for (const handler of handlers) {
          try {
            handler(message.params);
          } catch (error) {
            log("LSP notification handler failed", {
              method: message.method,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      return;
    }

    if ("id" in message) {
      if (message.id === null) return;
      const pending = this.pendingRequests.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(message.id);

      if ("error" in message) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private async handleIncomingRequest(message: JsonRpcRequestMessage): Promise<void> {
    const handler = this.requestHandlers.get(message.method);
    if (!handler) {
      try {
        this.sendRaw({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32601,
            message: `Method not implemented: ${message.method}`,
          },
        });
      } catch {}
      return;
    }

    try {
      const result = await handler(message.params);
      this.sendRaw({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      try {
        this.sendRaw({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      } catch {}
    }
  }

  private sendRaw(message: JsonRpcMessage): void {
    if (!this.proc || this.closed || this.proc.exitCode !== null) {
      throw new Error("LSP client not started");
    }

    const body = Buffer.from(JSON.stringify(message), "utf-8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf-8");
    this.proc.stdin.write(Buffer.concat([header, body]));
  }

  private markClosed(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPendingRequests(error);
    for (const handler of [...this.closeHandlers]) {
      try {
        handler(error);
      } catch {}
    }
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private startStderrReading(): void {
    if (!this.proc) return;
    const reader = this.proc.stderr.getReader();

    const read = async () => {
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          const text = decoder.decode(value);
          this.stderrBuffer.push(text);
          if (this.stderrBuffer.length > 100) this.stderrBuffer.shift();
        }
      } catch {}
    };

    void read();
  }
}
