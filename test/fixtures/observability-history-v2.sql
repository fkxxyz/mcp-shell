-- Frozen SQLite history schema from a838473 (SCHEMA_VERSION = 2).
-- Deliberately independent of current ObservabilityStore DDL/migration.
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
CREATE TABLE shell_activity (
  shell_id INTEGER PRIMARY KEY,
  cwd TEXT NOT NULL,
  last_event_at_ms INTEGER NOT NULL
);
CREATE INDEX shell_activity_recent ON shell_activity(last_event_at_ms DESC, shell_id DESC);
INSERT INTO tool_calls (
  id, sequence, started_at_ms, finished_at_ms, duration_ms,
  shell_id, cwd, session, actor, tool, status, input_preview_json,
  stored_bytes, payload_path
) VALUES (
  'legacy-v2', 1, 1791356400000, 1791356400010, 10,
  42, '/project', 'transport-2', 'actor-2', 'read', 'success', '{"path":"old.txt"}',
  64, 'payloads/2026/10/07/legacy-v2.json.gz'
);
INSERT INTO shell_activity (shell_id, cwd, last_event_at_ms)
VALUES (42, '/project', 1791356400010);
PRAGMA user_version = 2;
