import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { createInputPreview } from "./input-preview.js";
import type { ToolCallRecord } from "./tool-call.js";

const gunzipAsync = promisify(gunzip);
const MIGRATION_BATCH_SIZE = 500;
const PROGRESS_INTERVAL = 1_000;

type LegacyMigrationItem = {
  sourcePath: string;
  record: ToolCallRecord;
  inputPreview?: Record<string, unknown>;
  payloadPath: string;
  storedBytes: number;
};

export type LegacyImportResult = {
  imported: number;
  rejected: number;
};

export async function migrateLegacyToolLogs(
  logDir: string,
  db: DatabaseSync,
  publishPayloadIfMissing: (relativePath: string, compressed: Buffer) => Promise<void>,
): Promise<LegacyImportResult> {
  const callsDir = join(logDir, "calls");
  let entries;
  try {
    entries = await readdir(callsDir, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return { imported: 0, rejected: 0 };
    throw error;
  }

  const legacyFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json.gz"))
    .map((entry) => entry.name)
    .sort();

  for (const entry of entries) {
    if (entry.isFile() && isLegacyToolLogTempFile(entry.name)) {
      await unlinkIfExists(join(callsDir, entry.name));
    }
  }

  if (legacyFiles.length === 0) {
    await retireLegacyMetadata(logDir, callsDir);
    return { imported: 0, rejected: 0 };
  }

  console.log(`Migrating legacy tool history: 0/${legacyFiles.length}`);

  const pending: LegacyMigrationItem[] = [];
  let imported = 0;
  let rejected = 0;
  let lastReported = 0;

  const reportProgress = (force = false) => {
    const processed = imported + rejected;
    if (!force && processed - lastReported < PROGRESS_INTERVAL) return;
    lastReported = processed;
    console.log(`Migrating legacy tool history: ${processed}/${legacyFiles.length}`);
  };

  for (const filename of legacyFiles) {
    const sourcePath = join(callsDir, filename);
    let compressed: Buffer;
    let record: ToolCallRecord;

    try {
      compressed = await readFile(sourcePath);
      const raw = await gunzipAsync(compressed);
      record = JSON.parse(raw.toString("utf8")) as ToolCallRecord;
      if (!isToolCallRecord(record)) {
        throw new Error("legacy payload is not a valid tool-call record");
      }
    } catch (error) {
      const rejectedPath = await quarantineLegacyPayload(logDir, sourcePath, filename);
      rejected += 1;
      console.warn(`Rejected malformed legacy tool-log payload ${filename} -> ${rejectedPath}: ${errorMessage(error)}`);
      reportProgress();
      continue;
    }

    const payloadPath = payloadPathFor(record);
    await publishPayloadIfMissing(payloadPath, compressed);
    pending.push({
      sourcePath,
      record,
      inputPreview: createInputPreview(record.input),
      payloadPath,
      storedBytes: compressed.byteLength,
    });

    if (pending.length >= MIGRATION_BATCH_SIZE) {
      imported += await flushLegacyMigrationBatch(db, pending);
      reportProgress();
    }
  }

  imported += await flushLegacyMigrationBatch(db, pending);
  reportProgress(true);
  await retireLegacyMetadata(logDir, callsDir);
  console.log(
    `Legacy tool history migration complete: ${imported} imported, ${rejected} rejected`,
  );

  return { imported, rejected };
}

async function flushLegacyMigrationBatch(
  db: DatabaseSync,
  batch: LegacyMigrationItem[],
): Promise<number> {
  if (batch.length === 0) return 0;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO tool_calls (
      id, sequence, started_at_ms, finished_at_ms, duration_ms,
      shell_id, cwd, session, actor, client_name, client_session_id, tool, status, input_preview_json,
      stored_bytes, payload_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const item of batch) {
      insert.run(...metadataParams(item));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const committed = batch.splice(0, batch.length);
  for (const item of committed) await unlinkIfExists(item.sourcePath);
  return committed.length;
}

async function quarantineLegacyPayload(
  logDir: string,
  sourcePath: string,
  filename: string,
): Promise<string> {
  const rejectedDir = join(logDir, "legacy-rejected");
  await mkdir(rejectedDir, { recursive: true, mode: 0o700 });
  const targetPath = join(rejectedDir, `${filename}.${randomUUID()}.rejected`);
  await rename(sourcePath, targetPath);
  return targetPath;
}

async function retireLegacyMetadata(logDir: string, callsDir: string): Promise<void> {
  const remaining = await readdir(callsDir).catch((error: any) => {
    if (error?.code === "ENOENT") return [] as string[];
    throw error;
  });
  if (remaining.some((name) => name.endsWith(".json.gz"))) return;

  await unlinkIfExists(join(logDir, "index.jsonl"));
  if (remaining.length === 0) {
    await rmdir(callsDir).catch((error: any) => {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
    });
  }
}

function payloadPathFor(record: ToolCallRecord): string {
  const timestamp = new Date(record.started_at);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error(`Invalid tool-call start time: ${record.started_at}`);
  }
  const year = String(timestamp.getUTCFullYear()).padStart(4, "0");
  const month = String(timestamp.getUTCMonth() + 1).padStart(2, "0");
  const day = String(timestamp.getUTCDate()).padStart(2, "0");
  return `payloads/${year}/${month}/${day}/${record.id}.json.gz`;
}

function metadataParams(item: LegacyMigrationItem): Array<string | number | null> {
  const { record } = item;
  return [
    record.id,
    record.sequence,
    Date.parse(record.started_at),
    Date.parse(record.finished_at),
    record.duration_ms,
    record.shell_id ?? null,
    record.cwd ?? null,
    record.session ?? null,
    record.actor ?? null,
    record.client_name ?? null,
    record.client_session_id ?? null,
    record.tool,
    record.status,
    item.inputPreview ? JSON.stringify(item.inputPreview) : null,
    item.storedBytes,
    item.payloadPath,
  ];
}

function isToolCallRecord(value: ToolCallRecord): boolean {
  return Boolean(
    value &&
    value.version === 2 &&
    typeof value.id === "string" && value.id.length > 0 &&
    Number.isSafeInteger(value.sequence) && value.sequence >= 0 &&
    (value.shell_id === undefined || Number.isSafeInteger(value.shell_id)) &&
    (value.cwd === undefined || typeof value.cwd === "string") &&
    (value.session === undefined || typeof value.session === "string") &&
    (value.actor === undefined || typeof value.actor === "string") &&
    (value.client_name == null || typeof value.client_name === "string") &&
    (value.client_session_id == null || typeof value.client_session_id === "string") &&
    typeof value.started_at === "string" && Number.isFinite(Date.parse(value.started_at)) &&
    typeof value.finished_at === "string" && Number.isFinite(Date.parse(value.finished_at)) &&
    typeof value.duration_ms === "number" && Number.isFinite(value.duration_ms) && value.duration_ms >= 0 &&
    typeof value.tool === "string" && value.tool.length > 0 &&
    (value.status === "success" || value.status === "error"),
  );
}

function isLegacyToolLogTempFile(filename: string): boolean {
  return /^\.\d{8}T\d{6}\.\d{3}Z-\d{10}-[0-9a-f-]{36}\.json\.gz\.[0-9a-f-]{36}\.tmp$/.test(filename);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}
