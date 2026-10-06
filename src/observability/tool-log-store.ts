import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type { ToolCallIndexEntry, ToolCallRecord } from "./tool-call.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export type PersistResult = {
  file: string;
  storedBytes: number;
  evictedFiles: string[];
};

export class ToolLogStore {
  private readonly retention: PayloadRetention;

  constructor(
    private readonly logDir: string,
    private readonly maxCalls: number,
  ) {
    this.retention = new PayloadRetention(logDir, maxCalls);
  }

  async initialize(): Promise<void> {
    await this.retention.initialize();
  }

  async persist(record: ToolCallRecord): Promise<PersistResult> {
    await this.initialize();

    const callsDir = join(this.logDir, "calls");
    const indexFile = join(this.logDir, "index.jsonl");
    const filename = `${fileTimestamp(record.started_at)}-${String(record.sequence).padStart(10, "0")}-${record.id}.json.gz`;
    const relativeFile = `calls/${filename}`;
    const finalPath = join(callsDir, filename);
    const tempPath = join(callsDir, `.${filename}.${randomUUID()}.tmp`);

    const compressed = await gzipAsync(Buffer.from(JSON.stringify(record), "utf8"));

    try {
      await writeFile(tempPath, compressed, { mode: 0o600 });
      await rename(tempPath, finalPath);
    } catch (error) {
      await unlinkIfExists(tempPath);
      throw error;
    }

    const indexEntry: ToolCallIndexEntry = {
      version: record.version,
      id: record.id,
      sequence: record.sequence,
      shell_id: record.shell_id,
      cwd: record.cwd,
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

    let indexError: unknown;
    try {
      await appendFile(indexFile, `${JSON.stringify(indexEntry)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(indexFile, 0o600);
    } catch (error) {
      indexError = error;
    }

    const evicted = await this.retention.register(filename);

    if (indexError) throw indexError;

    return {
      file: relativeFile,
      storedBytes: compressed.byteLength,
      evictedFiles: evicted.map((name) => `calls/${name}`),
    };
  }

  async readRecent(limit: number): Promise<ToolCallIndexEntry[]> {
    if (limit <= 0) return [];
    const indexFile = join(this.logDir, "index.jsonl");

    let handle;
    try {
      handle = await open(indexFile, "r");
      const info = await handle.stat();
      const chunkSize = 64 * 1024;
      let position = info.size;
      let carry = Buffer.alloc(0);
      const newestFirst: ToolCallIndexEntry[] = [];

      while (position > 0 && newestFirst.length < limit) {
        const start = Math.max(0, position - chunkSize);
        const length = position - start;
        const buffer = Buffer.allocUnsafe(length);
        await handle.read(buffer, 0, length, start);
        const combined = carry.length === 0 ? buffer : Buffer.concat([buffer, carry]);

        let lineEnd = combined.length;
        for (let i = combined.length - 1; i >= 0 && newestFirst.length < limit; i--) {
          if (combined[i] !== 0x0a) continue;
          const line = combined.subarray(i + 1, lineEnd).toString("utf8");
          const entry = parseIndexLine(line);
          if (entry) newestFirst.push(entry);
          lineEnd = i;
        }

        carry = combined.subarray(0, lineEnd);
        position = start;
      }

      if (position === 0 && newestFirst.length < limit && carry.length > 0) {
        const entry = parseIndexLine(carry.toString("utf8"));
        if (entry) newestFirst.push(entry);
      }

      return newestFirst.reverse();
    } catch (error: any) {
      if (error?.code === "ENOENT") return [];
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async readPayload(relativeFile: string): Promise<ToolCallRecord | undefined> {
    if (!isPayloadPath(relativeFile)) return undefined;
    try {
      const compressed = await readFile(join(this.logDir, relativeFile));
      const raw = await gunzipAsync(compressed);
      return JSON.parse(raw.toString("utf8")) as ToolCallRecord;
    } catch (error: any) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }

  isPayloadRetained(relativeFile: string): boolean {
    if (!isPayloadPath(relativeFile)) return false;
    return this.retention.has(basename(relativeFile));
  }

  getMaxCalls(): number {
    return this.maxCalls;
  }
}

class PayloadRetention {
  private readonly callsDir: string;
  private readonly files = new Set<string>();
  private initialization: Promise<void> | undefined;
  private mutation = Promise.resolve<string[]>([]);

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
        if (this.initialization === initialization) this.initialization = undefined;
      });
    }
    return this.initialization;
  }

  async register(filename: string): Promise<string[]> {
    await this.initialize();
    const task = this.mutation.then(() => this.registerSerialized(filename));
    this.mutation = task.catch(() => []);
    return task;
  }

  has(filename: string): boolean {
    return this.files.has(filename);
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

  private async registerSerialized(filename: string): Promise<string[]> {
    this.files.add(filename);
    return this.prune();
  }

  private async prune(): Promise<string[]> {
    const evicted: string[] = [];
    while (this.files.size > this.maxCalls) {
      const oldest = this.findOldest();
      if (oldest === undefined) break;

      try {
        await unlink(join(this.callsDir, oldest));
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
      this.files.delete(oldest);
      evicted.push(oldest);
    }
    return evicted;
  }

  private findOldest(): string | undefined {
    let oldest: string | undefined;
    for (const filename of this.files) {
      if (oldest === undefined || filename < oldest) oldest = filename;
    }
    return oldest;
  }
}

function parseIndexLine(line: string): ToolCallIndexEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const entry = JSON.parse(trimmed) as ToolCallIndexEntry;
    if (
      typeof entry.id !== "string" ||
      typeof entry.tool !== "string" ||
      typeof entry.started_at !== "string" ||
      typeof entry.finished_at !== "string" ||
      typeof entry.file !== "string"
    ) {
      console.warn("Skipping malformed tool-log index entry");
      return undefined;
    }
    return entry;
  } catch {
    console.warn("Skipping malformed tool-log index line");
    return undefined;
  }
}

function isPayloadPath(relativeFile: string): boolean {
  return relativeFile === `calls/${basename(relativeFile)}` && relativeFile.endsWith(".json.gz");
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
