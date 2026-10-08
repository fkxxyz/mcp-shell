import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { ObservabilityStore } from "../src/observability/observability-store.js";
import type { ToolCallRecord } from "../src/observability/tool-call.js";

test("latest Shell activity survives call retention and store restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-observability-activity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const firstFinishedAt = Date.parse("2026-10-07T05:00:01.000Z");
  let store = new ObservabilityStore(dir, 1);
  await store.initialize();

  await store.persist(record("first", 1, 1, "/one", firstFinishedAt - 1_000, firstFinishedAt));
  await store.persist(record("second", 2, 2, "/two", firstFinishedAt + 1_000, firstFinishedAt + 2_000));

  assert.equal(store.listShellCalls(1, 10).items.length, 0, "retention should evict shell 1 call history");
  assert.deepEqual(store.getShellActivity(1), {
    shellId: 1,
    cwd: "/one",
    lastEventAt: firstFinishedAt,
  });

  store.close();

  store = new ObservabilityStore(dir, 1);
  await store.initialize();
  assert.deepEqual(store.getShellActivity(1), {
    shellId: 1,
    cwd: "/one",
    lastEventAt: firstFinishedAt,
  });
  store.close();
});

test("schema v1 history upgrades to durable Shell activity", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-observability-v1-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const finishedAt = Date.parse("2026-10-07T05:10:00.000Z");
  const db = new DatabaseSync(join(dir, "history.db"));
  db.exec(`
    CREATE TABLE tool_calls (
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
    CREATE INDEX tool_calls_retention ON tool_calls(started_at_ms, sequence, id);
    CREATE INDEX tool_calls_shell_history ON tool_calls(shell_id, started_at_ms DESC, sequence DESC, id DESC);
    INSERT INTO tool_calls (
      id, sequence, started_at_ms, finished_at_ms, duration_ms,
      shell_id, cwd, tool, status, stored_bytes, payload_path
    ) VALUES (
      'legacy-v1', 1, ${finishedAt - 1_000}, ${finishedAt}, 1000,
      42, '/v1-project', 'read', 'success', 1, 'payloads/2026/10/07/legacy-v1.json.gz'
    );
    PRAGMA user_version = 1;
  `);
  db.close();

  const store = new ObservabilityStore(dir, 10);
  try {
    await store.initialize();
    assert.deepEqual(store.getShellActivity(42), {
      shellId: 42,
      cwd: "/v1-project",
      lastEventAt: finishedAt,
    });
    assert.equal(store.listShellCalls(42, 10).items.length, 1);
  } finally {
    store.close();
  }
});

test("frozen schema v2 fixture upgrades in place without rewriting retained payloads", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-observability-v2-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // Historical v2 DDL comes from commit a838473, not reverse-engineered from
  // the latest schema (which could mask a missing migration step).
  const oldDb = new DatabaseSync(join(dir, "history.db"));
  oldDb.exec(await readFile(new URL("./fixtures/observability-history-v2.sql", import.meta.url), "utf8"));
  oldDb.close();

  const relativePayload = "payloads/2026/10/07/legacy-v2.json.gz";
  await mkdir(join(dir, "payloads/2026/10/07"), { recursive: true });
  const compressed = gzipSync(JSON.stringify({
    ...record("legacy-v2", 1, 42, "/project", 1791356400000, 1791356400010),
    input: { shell_id: 42, path: "old.txt" },
  }));
  await writeFile(join(dir, relativePayload), compressed);
  const before = await readFile(join(dir, relativePayload));

  let store = new ObservabilityStore(dir, 10);
  try {
    await store.initialize();
    assert.equal(store.listShellCalls(42, 10).items[0]?.clientName, undefined);
    assert.equal(store.listShellCalls(42, 10).items[0]?.clientSessionId, undefined);
    assert.equal(store.getShellActivity(42)?.lastEventAt, 1791356400010);
    const original = await store.readCall("legacy-v2");
    assert.equal(original.kind, "found");
    if (original.kind === "found") {
      assert.equal(original.record.tool, "read");
      assert.equal(original.record.client_name, undefined);
      assert.deepEqual(original.record.input, { shell_id: 42, path: "old.txt" });
    }
    assert.deepEqual(await readFile(join(dir, relativePayload)), before);

    const db = new DatabaseSync(join(dir, "history.db"));
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 3);
    const row = db.prepare("SELECT client_name, client_session_id FROM tool_calls WHERE id = ?").get("legacy-v2") as {
      client_name: string | null; client_session_id: string | null;
    };
    assert.equal(row.client_name, null);
    assert.equal(row.client_session_id, null);
    db.close();
  } finally {
    store.close();
  }

  store = new ObservabilityStore(dir, 10);
  try {
    await store.initialize();
    assert.equal(store.listShellCalls(42, 10).items.length, 1, "reopen must not rerun migrations or duplicate rows");
  } finally {
    store.close();
  }
});

function record(
  id: string,
  sequence: number,
  shellId: number,
  cwd: string,
  startedAt: number,
  finishedAt: number,
): ToolCallRecord {
  return {
    version: 2,
    id,
    sequence,
    shell_id: shellId,
    cwd,
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date(finishedAt).toISOString(),
    duration_ms: finishedAt - startedAt,
    tool: "read",
    input: { shell_id: shellId, path: "file.txt" },
    status: "success",
    output: { ok: true },
  };
}
