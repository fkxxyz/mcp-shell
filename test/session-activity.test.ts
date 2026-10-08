import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { ActivityService, ActivityUnavailableError } from "../src/observability/activity-service.js";
import { ACTIVITY_ACTIVE_WINDOW_MS as WINDOW } from "../src/observability/activity-policy.js";
import { ActivityTracker } from "../src/observability/activity-tracker.js";
import { ObservabilityStore } from "../src/observability/observability-store.js";
import { ToolCallRecorder, withToolLogContext } from "../src/observability/tool-call-recorder.js";
import type { RunningToolCall, ToolCallRecord } from "../src/observability/tool-call.js";
import { ObservabilityQuery, ObservabilityQueryError } from "../src/observability/observability-query.js";
import { ShellStore } from "../src/shell-store.js";

const NOW = 2_000_000;

test("sessions use the composite client identity and include first-time running Shells", async (t) => {
  const { store, presence } = await fixture(t);
  for (const [id, client, session] of [[1, "a", "same"], [2, "a", "same"], [3, "b", "same"], [4, "a", "other"]] as const) {
    presence.finished({ ...call(String(id), id, client, session), finishedAt: NOW - WINDOW });
  }
  presence.finished({ ...call("b-active", 3, "b", "same"), finishedAt: NOW });
  presence.finished({ ...call("other-active", 4, "a", "other"), finishedAt: NOW });
  assert.deepEqual(presence.getSessionActivityForShell(1, NOW), { active: false, activeUntil: NOW });

  presence.started(call("first-call", 5, "a", "same"));
  assert.deepEqual(presence.getSessionActivityForShell(1, NOW + WINDOW * 2), { active: true, activeUntil: null });
  assert.deepEqual(store.listSessionShellActivity(1).map((row) => row.shellId).sort(), [1, 2, 5]);
  presence.finished({ ...call("first-call", 5, "a", "same"), finishedAt: NOW + WINDOW * 2 });
  assert.deepEqual(presence.getSessionActivityForShell(1, NOW + WINDOW * 2), {
    active: true, activeUntil: NOW + WINDOW * 3,
  });

  const withoutShell = { ...call("skill", 99), shellId: undefined, cwd: undefined };
  presence.started(withoutShell);
  presence.finished({ ...withoutShell, finishedAt: NOW });
  presence.finished({ ...call("invalid-shell", 99), cwd: undefined, finishedAt: NOW });
  assert.deepEqual(store.listSessionShellActivity(99), []);
});

test("shared Shells aggregate direct sessions without transitive propagation", async (t) => {
  const { presence } = await fixture(t);
  for (const [shell, session] of [[1, "A"], [2, "A"], [2, "B"], [3, "B"]] as const) {
    presence.finished({ ...call(`${shell}-${session}`, shell, "client", session), finishedAt: NOW - WINDOW });
  }
  presence.finished({ ...call("active-3", 3, "client", "B"), finishedAt: NOW });
  assert.equal(presence.getSessionActivityForShell(1, NOW).active, false);
  assert.equal(presence.getSessionActivityForShell(2, NOW).active, true);
  assert.equal(presence.getSessionActivityForShell(3, NOW).active, true);
  assert.equal(presence.getShellActivity(2)?.lastEventAt, NOW - WINDOW);

  presence.finished({ ...call("active-shared", 2, "client", "A"), finishedAt: NOW + 10 });
  assert.deepEqual(presence.getSessionActivityForShell(1, NOW), {
    active: true, activeUntil: NOW + 10 + WINDOW,
  });
  assert.equal(presence.getSessionActivityForShell(1, NOW + 10 + WINDOW).active, false);
});

test("running calls are counted by invocation and completion time cannot move backwards", async (t) => {
  const { presence } = await fixture(t);
  const first = call("one", 1);
  const second = call("two", 1);
  presence.started(first);
  presence.started(first);
  presence.started(second);
  assert.equal(presence.getShellActivity(1)?.runningCallCount, 2);
  presence.finished({ ...second, finishedAt: NOW + 20 });
  assert.equal(presence.getShellActivity(1)?.runningCallCount, 1);
  assert.equal(presence.getSessionActivityForShell(1, NOW + WINDOW * 2).active, true);
  presence.finished({ ...first, finishedAt: NOW + 10 });
  presence.finished({ ...first, finishedAt: NOW + 10 });
  assert.equal(presence.getShellActivity(1)?.runningCallCount, 0);
  assert.equal(presence.getShellActivity(1)?.lastEventAt, NOW + 20);
  assert.deepEqual(presence.getSessionActivityForShell(1, NOW), {
    active: true, activeUntil: NOW + 20 + WINDOW,
  });
});

test("membership and completion state survive history retention and restart", async (t) => {
  const { dir, store, recorder } = await fixture(t);
  await withToolLogContext({ clientName: "a", clientSessionId: "same" }, async () => {
    for (const shellId of [1, 2]) {
      await recorder.run({ tool: "read", input: {}, shellId, cwd: "/project" }, async () => "ok");
    }
  });
  assert.equal(store.readRecent(10).length, 1);
  assert.equal(store.listShellCalls(1, 10).items.length, 0);
  store.close();
  const restarted = new ObservabilityStore(dir, 1);
  t.after(() => restarted.close());
  await restarted.initialize();
  const presence = new ActivityService(restarted);
  assert.deepEqual(restarted.listSessionShellActivity(1).map((row) => row.shellId).sort(), [1, 2]);
  assert.equal(presence.getSessionActivityForShell(1, Date.now()).active, true);
  assert.equal(presence.getShellActivity(1)?.runningCallCount, 0);
});

test("payload failures preserve activity and original tool outcomes, including after restart", async (t) => {
  const { dir, store, presence, recorder } = await fixture(t);
  t.mock.method(console, "error", () => {});
  await rm(join(dir, "payloads"), { recursive: true });
  await writeFile(join(dir, "payloads"), "blocked payload directory");
  await withToolLogContext({ clientName: "a", clientSessionId: "same" }, async () => {
    assert.equal(await recorder.run({ tool: "read", input: {}, shellId: 1, cwd: "/project" }, async () => "ok"), "ok");
    const error = new Error("original tool error");
    await assert.rejects(recorder.run({ tool: "read", input: {}, shellId: 2, cwd: "/project" }, async () => {
      throw error;
    }), (received) => received === error);
  });
  assert.equal(presence.getSessionActivityForShell(1, Date.now()).active, true);
  assert.equal(presence.getShellActivity(2)?.runningCallCount, 0);
  assert.deepEqual(store.readRecent(10), []);
  store.close();
  const restarted = new ObservabilityStore(dir, 1);
  t.after(() => restarted.close());
  await assert.rejects(restarted.initialize());
  await restarted.initializeActivity();
  assert.equal(new ActivityService(restarted).getSessionActivityForShell(1, Date.now()).active, true);
});

test("completion is visible while full history persistence is still pending", async (t) => {
  const { dir, store, presence, recorder, tracker } = await fixture(t);
  const shells = await ShellStore.open(dir, join(dir, "shells.db"));
  t.after(() => shells.close());
  const query = new ObservabilityQuery(shells, store, tracker, presence);
  const entered = deferred();
  const release = deferred();
  const originalPersist = store.persist.bind(store);
  t.mock.method(store, "persist", async (record: ToolCallRecord, preview?: Record<string, unknown>) => {
    entered.resolve();
    await release.promise;
    return originalPersist(record, preview);
  });
  const pending = withToolLogContext({ clientName: "a", clientSessionId: "same" }, () =>
    recorder.run({ tool: "read", input: {}, shellId: 1, cwd: "/project" }, async () => "ok"));
  try {
    await entered.promise;
    assert.equal(presence.getShellActivity(1)?.runningCallCount, 0);
    assert.equal(presence.getSessionActivityForShell(1, Date.now()).active, true);
    const workspace = tracker.snapshot().workspaces[0]!;
    assert.equal(workspace.runningCallCount, 0);
    assert.equal(workspace.recentCalls[0]?.status, "success");
    await assert.rejects(query.getToolCall(workspace.recentCalls[0]!.id), (error) =>
      error instanceof ObservabilityQueryError && error.status === 409 && error.code === "tool_call_running");
  } finally {
    release.resolve();
    await pending;
  }
  const completed = tracker.snapshot().workspaces[0]!.recentCalls[0]!;
  assert.equal((await query.getToolCall(completed.id)).status, "success");
});

test("activity write failure remains visible even after subsequent storage recovery", async (t) => {
  const { dir, store, presence, recorder } = await fixture(t);
  t.mock.method(console, "error", () => {});
  const db = new DatabaseSync(join(dir, "history.db"));
  t.after(() => db.close());
  db.exec(`CREATE TRIGGER fail_membership BEFORE INSERT ON session_shells
    BEGIN SELECT RAISE(ABORT, 'test activity write failure'); END;`);
  await withToolLogContext({ clientName: "a", clientSessionId: "same" }, async () => {
    assert.equal(await recorder.run({ tool: "read", input: {}, shellId: 1, cwd: "/project" }, async () => "ok"), "ok");
    db.exec("DROP TRIGGER fail_membership");
    await recorder.run({ tool: "read", input: {}, shellId: 2, cwd: "/project" }, async () => "ok");
  });
  assert.ok(store.getShellActivity(2));
  assert.throws(() => presence.getSessionActivityForShell(1, Date.now()), ActivityUnavailableError);
  assert.throws(() => presence.getShellActivity(2), ActivityUnavailableError);
});

test("frozen v3 history backfills client-scoped membership before retention runs", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-session-v3-"));
  const db = new DatabaseSync(join(dir, "history.db"));
  db.exec(await readFile(new URL("./fixtures/observability-history-v3.sql", import.meta.url), "utf8"));
  db.close();
  const store = new ObservabilityStore(dir, 1);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  await store.initialize();
  assert.equal(store.readRecent(10).length, 1);
  assert.deepEqual(store.listSessionShellActivity(1).map((row) => row.shellId).sort(), [1, 2]);
  assert.deepEqual(store.listSessionShellActivity(3).map((row) => row.shellId), [3]);
  assert.deepEqual(store.listSessionShellActivity(99), []);
  store.close();
  const restarted = new ObservabilityStore(dir, 1);
  try {
    await restarted.initialize();
    assert.deepEqual(restarted.listSessionShellActivity(1).map((row) => row.shellId).sort(), [1, 2]);
  } finally {
    restarted.close();
  }
});

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "mcp-session-activity-"));
  const store = new ObservabilityStore(dir, 1);
  await store.initialize();
  const presence = new ActivityService(store);
  const tracker = new ActivityTracker(1);
  const recorder = new ToolCallRecorder(store, tracker, presence);
  t.after(async () => {
    tracker.close(); store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, store, presence, tracker, recorder };
}

function call(id: string, shellId: number, clientName = "a", clientSessionId = "same"): RunningToolCall {
  return { id, tool: "read", shellId, cwd: "/project", clientName, clientSessionId, startedAt: NOW };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
