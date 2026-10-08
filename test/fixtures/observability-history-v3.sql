-- Frozen schema v3 from the client identity implementation (b9041b5).
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
  client_name TEXT,
  client_session_id TEXT,
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
INSERT INTO tool_calls (id, sequence, started_at_ms, finished_at_ms, duration_ms,
  shell_id, cwd, client_name, client_session_id, tool, status, stored_bytes, payload_path) VALUES
  ('old-a1', 1, 1000, 1010, 10, 1, '/project', 'a', 'same', 'read', 'success', 1, 'payloads/old-a1.json.gz'),
  ('old-a2', 2, 2000, 2010, 10, 2, '/project', 'a', 'same', 'read', 'success', 1, 'payloads/old-a2.json.gz'),
  ('old-b3', 3, 3000, 3010, 10, 3, '/project', 'b', 'same', 'read', 'success', 1, 'payloads/old-b3.json.gz'),
  ('unknown-shell', 4, 4000, 4010, 10, 99, NULL, 'a', 'same', 'read', 'error', 1, 'payloads/unknown.json.gz');
INSERT INTO shell_activity VALUES (1, '/project', 1010), (2, '/project', 2010), (3, '/project', 3010);
PRAGMA user_version = 3;
