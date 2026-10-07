import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { migrateLegacyToolLogs } from "./legacy-tool-log-import.js";
import type { FinishedToolCallSummary, ToolCallRecord } from "./tool-call.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const SCHEMA_VERSION = 2;
const RETENTION_BATCH_SIZE = 1_000;

export type ToolHistoryCursor = {
  startedAt: number;
  sequence: number;
  id: string;
};

export type ToolHistoryPage = {
  items: FinishedToolCallSummary[];
  nextCursor?: ToolHistoryCursor;
};

export type PersistResult = {
  storedBytes: number;
  retained: boolean;
  evictedCallIds: string[];
};

export type ToolCallReadResult =
  | { kind: "found"; record: ToolCallRecord }
  | { kind: "not_found" }
  | { kind: "payload_missing" };

export type ShellActivityRecord = {
  shellId: number;
  cwd: string;
  lastEventAt: number;
};

type ToolHistoryRow = {
  history_id: number;
  id: string;
  sequence: number;
  started_at_ms: number;
  finished_at_ms: number;
  duration_ms: number;
  shell_id: number | null;
  cwd: string | null;
  tool: string;
  status: "success" | "error";
  input_preview_json: string | null;
  payload_path: string;
};

type RetentionVictim = {
  history_id: number;
  id: string;
  payload_path: string;
};

export class ObservabilityStore {
  private readonly dbFile: string;
  private readonly payloadRoot: string;
  private db: DatabaseSync | undefined;
  private insertCall: StatementSync | undefined;
  private upsertShellActivity: StatementSync | undefined;
  private initialization: Promise<void> | undefined;
  private closed = false;
  private retainedCount = 0;

  constructor(
    private readonly logDir: string,
    private readonly maxCalls: number,
  ) {
    this.dbFile = join(logDir, "history.db");
    this.payloadRoot = join(logDir, "payloads");
  }

  initialize(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Observability store is closed"));
    if (this.initialization === undefined) {
      this.initialization = this.initializeOnce();
    }
    return this.initialization;
  }

  async persist(
    record: ToolCallRecord,
    inputPreview?: Record<string, unknown>,
  ): Promise<PersistResult> {
    await this.initialize();
    const compressed = await gzipAsync(Buffer.from(JSON.stringify(record), "utf8"));
    const payloadPath = this.payloadPathFor(record);
    await this.publishPayload(payloadPath, compressed);

    let victims: RetentionVictim[] = [];
    try {
      const db = this.requireDb();
      db.exec("BEGIN IMMEDIATE");
      try {
        this.requireInsertCall().run(...metadataParams(record, inputPreview, payloadPath, compressed.byteLength));
        if (record.shell_id != null && record.cwd) {
          this.requireUpsertShellActivity().run(
            record.shell_id,
            record.cwd,
            Date.parse(record.finished_at),
          );
        }
        const nextCount = this.retainedCount + 1;
        const excess = Math.max(0, nextCount - this.maxCalls);
        victims = this.deleteOldestRows(excess);
        db.exec("COMMIT");
        this.retainedCount = nextCount - victims.length;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      // Metadata publication is the visibility boundary. A payload published
      // before a failed metadata transaction is an invisible orphan and may
      // be reclaimed later without corrupting user-visible history.
      throw error;
    }

    await this.removePayloads(victims.map((victim) => victim.payload_path));
    const evictedCallIds = victims.map((victim) => victim.id);
    return {
      storedBytes: compressed.byteLength,
      retained: !evictedCallIds.includes(record.id),
      evictedCallIds,
    };
  }

  readRecent(limit: number): FinishedToolCallSummary[] {
    if (limit <= 0) return [];
    const rows = this.requireDb().prepare(`
      SELECT ${SUMMARY_COLUMNS}
      FROM tool_calls
      ORDER BY started_at_ms DESC, sequence DESC, id DESC
      LIMIT ?
    `).all(limit) as ToolHistoryRow[];
    return rows.map(rowToSummary);
  }

  listShellCalls(shellId: number, limit: number, before?: ToolHistoryCursor): ToolHistoryPage {
    if (limit <= 0) return { items: [] };
    const rows = this.requireDb().prepare(`
      SELECT ${SUMMARY_COLUMNS}
      FROM tool_calls
      WHERE shell_id = ?
        AND (
          ? IS NULL OR
          started_at_ms < ? OR
          (started_at_ms = ? AND sequence < ?) OR
          (started_at_ms = ? AND sequence = ? AND id < ?)
        )
      ORDER BY started_at_ms DESC, sequence DESC, id DESC
      LIMIT ?
    `).all(
      shellId,
      before?.startedAt ?? null,
      before?.startedAt ?? null,
      before?.startedAt ?? null,
      before?.sequence ?? null,
      before?.startedAt ?? null,
      before?.sequence ?? null,
      before?.id ?? null,
      limit,
    ) as ToolHistoryRow[];

    const last = rows.at(-1);
    return {
      items: rows.map(rowToSummary),
      nextCursor: rows.length === limit && last
        ? { startedAt: last.started_at_ms, sequence: last.sequence, id: last.id }
        : undefined,
    };
  }

  getShellActivity(shellId: number): ShellActivityRecord | undefined {
    const row = this.requireDb().prepare(`
      SELECT shell_id, cwd, last_event_at_ms
      FROM shell_activity
      WHERE shell_id = ?
    `).get(shellId) as { shell_id: number; cwd: string; last_event_at_ms: number } | undefined;
    return row ? {
      shellId: row.shell_id,
      cwd: row.cwd,
      lastEventAt: row.last_event_at_ms,
    } : undefined;
  }

  listShellActivitySince(sinceMs: number): ShellActivityRecord[] {
    const rows = this.requireDb().prepare(`
      SELECT shell_id, cwd, last_event_at_ms
      FROM shell_activity
      WHERE last_event_at_ms >= ?
      ORDER BY last_event_at_ms DESC, shell_id DESC
    `).all(sinceMs) as Array<{ shell_id: number; cwd: string; last_event_at_ms: number }>;
    return rows.map((row) => ({
      shellId: row.shell_id,
      cwd: row.cwd,
      lastEventAt: row.last_event_at_ms,
    }));
  }

  async readCall(callId: string): Promise<ToolCallReadResult> {
    const row = this.requireDb().prepare(
      "SELECT payload_path FROM tool_calls WHERE id = ?",
    ).get(callId) as { payload_path: string } | undefined;
    if (!row) return { kind: "not_found" };

    let compressed: Buffer;
    try {
      compressed = await readFile(this.absolutePayloadPath(row.payload_path));
    } catch (error: any) {
      if (error?.code === "ENOENT") return { kind: "payload_missing" };
      throw error;
    }

    const raw = await gunzipAsync(compressed);
    return { kind: "found", record: JSON.parse(raw.toString("utf8")) as ToolCallRecord };
  }

  getMaxCalls(): number {
    return this.maxCalls;
  }

  close(): void {
    this.closed = true;
    this.closeDatabase();
  }

  private closeDatabase(): void {
    this.insertCall = undefined;
    this.upsertShellActivity = undefined;
    this.db?.close();
    this.db = undefined;
  }

  private async initializeOnce(): Promise<void> {
    await mkdir(this.logDir, { recursive: true, mode: 0o700 });
    await chmod(this.logDir, 0o700);
    await mkdir(this.payloadRoot, { recursive: true, mode: 0o700 });
    await chmod(this.payloadRoot, 0o700);

    const db = new DatabaseSync(this.dbFile);
    this.db = db;
    try {
      this.initializeSchema(db);
      await chmod(this.dbFile, 0o600);
      this.prepareStatements(db);
      const legacyImport = await migrateLegacyToolLogs(
        this.logDir,
        db,
        (relativePath, compressed) => this.publishPayloadIfMissing(relativePath, compressed),
      );
      if (legacyImport.imported > 0) this.backfillShellActivityFromHistory();
      this.retainedCount = Number(
        (db.prepare("SELECT COUNT(*) AS count FROM tool_calls").get() as { count: number }).count,
      );
      const victims = this.deleteOldestRows(Math.max(0, this.retainedCount - this.maxCalls));
      this.retainedCount -= victims.length;
      await this.removePayloads(victims.map((victim) => victim.payload_path));
    } catch (error) {
      this.closeDatabase();
      throw error;
    }
  }

  private initializeSchema(db: DatabaseSync): void {
    // Tool history is best-effort observability, not host-action durability.
    // WAL/NORMAL keeps metadata consistent while avoiding a synchronous fsync
    // on every completed tool call; a sudden power loss may lose recent logs.
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");

    const currentVersion = Number(
      (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    );
    if (currentVersion < 0 || currentVersion > SCHEMA_VERSION) {
      throw new Error(`Unsupported observability schema version: ${currentVersion}`);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS tool_calls (
        history_id INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        sequence INTEGER NOT NULL,
        started_at_ms INTEGER NOT NULL,
        finished_at_ms INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        shell_id INTEGER,
        cwd TEXT,
        session TEXT,
        actor TEXT,
        tool TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('success', 'error')),
        input_preview_json TEXT,
        stored_bytes INTEGER NOT NULL,
        payload_path TEXT NOT NULL UNIQUE
      );

      CREATE INDEX IF NOT EXISTS tool_calls_retention
        ON tool_calls(started_at_ms, sequence, id);

      CREATE INDEX IF NOT EXISTS tool_calls_shell_history
        ON tool_calls(shell_id, started_at_ms DESC, sequence DESC, id DESC);

      CREATE TABLE IF NOT EXISTS shell_activity (
        shell_id INTEGER PRIMARY KEY,
        cwd TEXT NOT NULL,
        last_event_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS shell_activity_recent
        ON shell_activity(last_event_at_ms DESC, shell_id DESC);
    `);

    if (currentVersion < 2) {
      db.exec(`
        INSERT OR REPLACE INTO shell_activity (shell_id, cwd, last_event_at_ms)
        SELECT t.shell_id, t.cwd, t.finished_at_ms
        FROM tool_calls AS t
        WHERE t.shell_id IS NOT NULL
          AND t.cwd IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM tool_calls AS newer
            WHERE newer.shell_id = t.shell_id
              AND (
                newer.finished_at_ms > t.finished_at_ms OR
                (newer.finished_at_ms = t.finished_at_ms AND newer.history_id > t.history_id)
              )
          );
      `);
    }

    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  }

  private prepareStatements(db: DatabaseSync): void {
    const sql = `
      INSERT INTO tool_calls (
        id, sequence, started_at_ms, finished_at_ms, duration_ms,
        shell_id, cwd, session, actor, tool, status, input_preview_json,
        stored_bytes, payload_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    this.insertCall = db.prepare(sql);
    this.upsertShellActivity = db.prepare(`
      INSERT INTO shell_activity (shell_id, cwd, last_event_at_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(shell_id) DO UPDATE SET
        cwd = excluded.cwd,
        last_event_at_ms = excluded.last_event_at_ms
      WHERE excluded.last_event_at_ms >= shell_activity.last_event_at_ms
    `);
  }

  private backfillShellActivityFromHistory(): void {
    const rows = this.requireDb().prepare(`
      SELECT t.shell_id, t.cwd, t.finished_at_ms
      FROM tool_calls AS t
      WHERE t.shell_id IS NOT NULL
        AND t.cwd IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM tool_calls AS newer
          WHERE newer.shell_id = t.shell_id
            AND (
              newer.finished_at_ms > t.finished_at_ms OR
              (newer.finished_at_ms = t.finished_at_ms AND newer.history_id > t.history_id)
            )
        )
    `).all() as Array<{ shell_id: number; cwd: string; finished_at_ms: number }>;

    for (const row of rows) {
      this.requireUpsertShellActivity().run(row.shell_id, row.cwd, row.finished_at_ms);
    }
  }

  private deleteOldestRows(count: number): RetentionVictim[] {
    if (count <= 0) return [];
    const db = this.requireDb();
    const select = db.prepare(`
      SELECT history_id, id, payload_path
      FROM tool_calls
      ORDER BY started_at_ms, sequence, id
      LIMIT ?
    `);
    const remove = db.prepare("DELETE FROM tool_calls WHERE history_id = ?");
    const victims: RetentionVictim[] = [];
    const ownsTransaction = !db.isTransaction;

    if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
    try {
      let remaining = count;
      while (remaining > 0) {
        const batch = select.all(Math.min(remaining, RETENTION_BATCH_SIZE)) as RetentionVictim[];
        if (batch.length === 0) break;
        for (const victim of batch) remove.run(victim.history_id);
        victims.push(...batch);
        remaining -= batch.length;
      }
      if (ownsTransaction) db.exec("COMMIT");
    } catch (error) {
      if (ownsTransaction) db.exec("ROLLBACK");
      throw error;
    }
    return victims;
  }

  private async publishPayload(relativePath: string, compressed: Buffer): Promise<void> {
    const finalPath = this.absolutePayloadPath(relativePath);
    const dir = dirname(finalPath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tempPath = join(dir, `.${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, compressed, { mode: 0o600 });
      await rename(tempPath, finalPath);
    } catch (error) {
      await unlinkIfExists(tempPath);
      throw error;
    }
  }

  private async publishPayloadIfMissing(relativePath: string, compressed: Buffer): Promise<void> {
    const finalPath = this.absolutePayloadPath(relativePath);
    try {
      await access(finalPath);
      return;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    await this.publishPayload(relativePath, compressed);
  }

  private async removePayloads(paths: string[]): Promise<void> {
    for (const path of paths) {
      try {
        await unlink(this.absolutePayloadPath(path));
      } catch (error: any) {
        if (error?.code !== "ENOENT") {
          console.error(`Failed to remove retired tool payload ${path}:`, error);
        }
      }
    }
  }

  private payloadPathFor(record: ToolCallRecord): string {
    const timestamp = new Date(record.started_at);
    if (Number.isNaN(timestamp.getTime())) throw new Error(`Invalid tool-call start time: ${record.started_at}`);
    const year = String(timestamp.getUTCFullYear()).padStart(4, "0");
    const month = String(timestamp.getUTCMonth() + 1).padStart(2, "0");
    const day = String(timestamp.getUTCDate()).padStart(2, "0");
    return `payloads/${year}/${month}/${day}/${record.id}.json.gz`;
  }

  private absolutePayloadPath(relativePath: string): string {
    const absolute = resolve(this.logDir, relativePath);
    const rootPrefix = `${resolve(this.payloadRoot)}${sep}`;
    if (!absolute.startsWith(rootPrefix) || !relativePath.endsWith(".json.gz")) {
      throw new Error(`Invalid tool payload path: ${relativePath}`);
    }
    return absolute;
  }

  private requireDb(): DatabaseSync {
    if (!this.db) throw new Error("Observability store is not initialized");
    return this.db;
  }

  private requireInsertCall(): StatementSync {
    if (!this.insertCall) throw new Error("Observability store is not initialized");
    return this.insertCall;
  }

  private requireUpsertShellActivity(): StatementSync {
    if (!this.upsertShellActivity) throw new Error("Observability store is not initialized");
    return this.upsertShellActivity;
  }

}

const SUMMARY_COLUMNS = `
  history_id, id, sequence, started_at_ms, finished_at_ms, duration_ms,
  shell_id, cwd, tool, status, input_preview_json, payload_path
`;

function metadataParams(
  record: ToolCallRecord,
  inputPreview: Record<string, unknown> | undefined,
  payloadPath: string,
  storedBytes: number,
): Array<string | number | null> {
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
    record.tool,
    record.status,
    inputPreview ? JSON.stringify(inputPreview) : null,
    storedBytes,
    payloadPath,
  ];
}

function rowToSummary(row: ToolHistoryRow): FinishedToolCallSummary {
  return {
    id: row.id,
    tool: row.tool,
    shellId: row.shell_id ?? undefined,
    cwd: row.cwd ?? undefined,
    inputPreview: parseInputPreview(row.input_preview_json),
    startedAt: row.started_at_ms,
    finishedAt: row.finished_at_ms,
    durationMs: row.duration_ms,
    status: row.status,
    payloadAvailable: true,
  };
}

function parseInputPreview(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    console.warn("Skipping malformed tool-history input preview");
    return undefined;
  }
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}
