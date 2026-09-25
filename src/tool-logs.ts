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
  await mkdir(callsDir, { recursive: true, mode: 0o700 });
  await chmod(logDir, 0o700);
  await chmod(callsDir, 0o700);

  const filename = `${fileTimestamp(record.started_at)}-${String(record.sequence).padStart(10, "0")}-${record.id}.json.gz`;
  const relativeFile = `calls/${filename}`;
  const finalPath = join(callsDir, filename);
  const tempPath = join(callsDir, `.${filename}.${randomUUID()}.tmp`);
  const json = JSON.stringify(record);
  const compressed = await gzipAsync(Buffer.from(json, "utf8"));

  await writeFile(tempPath, compressed, { mode: 0o600 });
  await rename(tempPath, finalPath);

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

  await appendFile(indexFile, `${JSON.stringify(indexEntry)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(indexFile, 0o600);
  await cleanupOldToolCalls(callsDir, getMaxCalls());
}

async function cleanupOldToolCalls(callsDir: string, maxCalls: number): Promise<void> {
  const entries = await readdir(callsDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json.gz"))
    .map((entry) => entry.name)
    .sort();

  const excess = files.length - maxCalls;
  if (excess <= 0) return;

  for (const filename of files.slice(0, excess)) {
    try {
      await unlink(join(callsDir, filename));
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
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
