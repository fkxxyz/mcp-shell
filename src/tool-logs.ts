import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

const gzipAsync = promisify(gzip);
const DEFAULT_MAX_CALLS = 10_000;
let callSequence = 0;
let payloadRetentionKey: string | undefined;
let payloadRetention: PayloadRetention | undefined;

export type ToolLogContext = {
  session?: string;
  actor?: string;
};

type ToolCallRecord = {
  version: 1;
  id: string;
  sequence: number;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  session?: string;
  actor?: string;
  tool: string;
  input: unknown;
  status: "success" | "error";
  output?: unknown;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
};

const contextStorage = new AsyncLocalStorage<ToolLogContext>();

export function toolLogActorFromToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export function withToolLogContext<T>(context: ToolLogContext, callback: () => T): T {
  return contextStorage.run(context, callback);
}

export async function recordToolCall<T>(
  tool: string,
  input: unknown,
  execute: () => Promise<T>,
): Promise<T> {
  const id = randomUUID();
  const sequence = nextCallSequence();
  const startedAt = new Date();
  const startedMs = Date.now();
  const context = contextStorage.getStore();

  try {
    const output = await execute();
    const finishedAt = new Date();

    await persistToolCallSafely({
      version: 1,
      id,
      sequence,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: Date.now() - startedMs,
      session: context?.session,
      actor: context?.actor,
      tool,
      input,
      status: "success",
      output,
    });

    return output;
  } catch (error) {
    const finishedAt = new Date();

    await persistToolCallSafely({
      version: 1,
      id,
      sequence,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: Date.now() - startedMs,
      session: context?.session,
      actor: context?.actor,
      tool,
      input,
      status: "error",
      error: serializeError(error),
    });

    throw error;
  }
}

function getToolLogDir(): string {
  return process.env.TOOL_LOG_DIR || join(homedir(), ".mcp-shell", "tool-logs");
}

function getMaxCalls(): number {
  const value = Number(process.env.TOOL_LOG_MAX_CALLS ?? DEFAULT_MAX_CALLS);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_CALLS;
}

async function persistToolCallSafely(record: ToolCallRecord): Promise<void> {
  try {
    await persistToolCall(record);
  } catch (error) {
    console.error("Failed to persist tool log:", error);
  }
}

async function persistToolCall(record: ToolCallRecord): Promise<void> {
  const logDir = getToolLogDir();
  const callsDir = join(logDir, "calls");
  const indexFile = join(logDir, "index.jsonl");
  const retention = getPayloadRetention(logDir, getMaxCalls());
  await retention.initialize();

  const filename = `${fileTimestamp(record.started_at)}-${String(record.sequence).padStart(10, "0")}-${record.id}.json.gz`;
  const relativeFile = `calls/${filename}`;
  const finalPath = join(callsDir, filename);
  const tempPath = join(callsDir, `.${filename}.${randomUUID()}.tmp`);
  const json = JSON.stringify(record);
  const compressed = await gzipAsync(Buffer.from(json, "utf8"));

  try {
    await writeFile(tempPath, compressed, { mode: 0o600 });
    await rename(tempPath, finalPath);
  } catch (error) {
    await unlinkIfExists(tempPath);
    throw error;
  }

  const indexEntry = {
    id: record.id,
    sequence: record.sequence,
    started_at: record.started_at,
    finished_at: record.finished_at,
    duration_ms: record.duration_ms,
    session: record.session,
    actor: record.actor,
    tool: record.tool,
    status: record.status,
    stored_bytes: compressed.byteLength,
    file: relativeFile,
  };

  let indexFailed = false;
  let indexError: unknown;
  try {
    await appendFile(indexFile, `${JSON.stringify(indexEntry)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(indexFile, 0o600);
  } catch (error) {
    indexFailed = true;
    indexError = error;
  }

  try {
    await retention.register(filename);
  } catch (retentionError) {
    if (indexFailed) {
      throw new AggregateError(
        [indexError, retentionError],
        "Failed to persist tool log index and enforce payload retention",
      );
    }
    throw retentionError;
  }

  if (indexFailed) throw indexError;
}

function getPayloadRetention(logDir: string, maxCalls: number): PayloadRetention {
  const key = `${logDir}\0${maxCalls}`;
  if (payloadRetention === undefined || payloadRetentionKey !== key) {
    payloadRetention = new PayloadRetention(logDir, maxCalls);
    payloadRetentionKey = key;
  }
  return payloadRetention;
}

class PayloadRetention {
  private readonly callsDir: string;
  private readonly files = new Set<string>();
  private initialization: Promise<void> | undefined;
  private mutation = Promise.resolve();

  constructor(
    private readonly logDir: string,
    private readonly maxCalls: number,
  ) {
    this.callsDir = join(logDir, "calls");
  }

  initialize(): Promise<void> {
    if (this.initialization === undefined) {
      const initialization = this.initializeOnce();
      this.initialization = initialization;
      void initialization.catch(() => {
        if (this.initialization === initialization) {
          this.initialization = undefined;
        }
      });
    }
    return this.initialization;
  }

  async register(filename: string): Promise<void> {
    await this.initialize();
    const task = this.mutation.then(() => this.registerSerialized(filename));
    this.mutation = task.catch(() => {});
    return task;
  }

  private async initializeOnce(): Promise<void> {
    await mkdir(this.callsDir, { recursive: true, mode: 0o700 });
    await chmod(this.logDir, 0o700);
    await chmod(this.callsDir, 0o700);

    this.files.clear();
    const entries = await readdir(this.callsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json.gz")) {
        this.files.add(entry.name);
      } else if (entry.isFile() && isToolLogTempFile(entry.name)) {
        await unlinkIfExists(join(this.callsDir, entry.name));
      }
    }

    await this.prune();
  }

  private async registerSerialized(filename: string): Promise<void> {
    this.files.add(filename);
    await this.prune();
  }

  private async prune(): Promise<void> {
    while (this.files.size > this.maxCalls) {
      const oldest = this.findOldest();
      if (oldest === undefined) return;

      try {
        await unlink(join(this.callsDir, oldest));
        this.files.delete(oldest);
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
        this.files.delete(oldest);
      }
    }
  }

  private findOldest(): string | undefined {
    let oldest: string | undefined;
    for (const filename of this.files) {
      if (oldest === undefined || filename < oldest) oldest = filename;
    }
    return oldest;
  }
}

function isToolLogTempFile(filename: string): boolean {
  return /^\.\d{8}T\d{6}\.\d{3}Z-\d{10}-[0-9a-f-]{36}\.json\.gz\.[0-9a-f-]{36}\.tmp$/.test(filename);
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function fileTimestamp(isoTimestamp: string): string {
  return isoTimestamp.replace(/[-:]/g, "");
}

function nextCallSequence(): number {
  callSequence += 1;
  return callSequence;
}

function serializeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    name: "Error",
    message: String(error),
  };
}
