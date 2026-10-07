import assert from "node:assert/strict";
import test from "node:test";
import { ActivityTracker } from "../src/observability/activity-tracker.js";

test("openFeed snapshot and queued live event form one lossless handoff", async () => {
  const tracker = new ActivityTracker(100);
  tracker.started({
    id: "before",
    tool: "read",
    shellId: 1,
    cwd: "/workspace",
    startedAt: 100,
  });

  const opened = tracker.openFeed();

  tracker.started({
    id: "after",
    tool: "bash",
    shellId: 1,
    cwd: "/workspace",
    startedAt: 200,
  });

  assert.equal(opened.snapshot.workspaces.length, 1);
  assert.equal(opened.snapshot.workspaces[0]?.recentCalls.some((call) => call.id === "before"), true);
  assert.equal(opened.snapshot.workspaces[0]?.recentCalls.some((call) => call.id === "after"), false);

  const event = await opened.feed.next();
  assert.equal(event?.type, "tool_call.started");
  assert.equal(event?.call.id, "after");

  opened.feed.close();
  tracker.close();
});

test("queued lifecycle events freeze presence at publication time", async () => {
  const tracker = new ActivityTracker(100);
  const opened = tracker.openFeed();
  const startedAt = Date.now();

  tracker.started({
    id: "race",
    tool: "bash",
    shellId: 7,
    cwd: "/workspace",
    startedAt,
  });
  tracker.finished({
    id: "race",
    tool: "bash",
    shellId: 7,
    cwd: "/workspace",
    startedAt,
    finishedAt: startedAt + 10,
    durationMs: 10,
    status: "success",
    payloadAvailable: true,
  });

  const started = await opened.feed.next();
  const finished = await opened.feed.next();
  assert.equal(started?.type, "tool_call.started");
  assert.equal(started?.workspaceActivity?.runningCallCount, 1);
  assert.equal(started?.shellActivity?.runningCallCount, 1);
  assert.equal(finished?.type, "tool_call.finished");
  assert.equal(finished?.workspaceActivity?.runningCallCount, 0);
  assert.equal(finished?.shellActivity?.runningCallCount, 0);
  assert.equal(finished?.shellActivity?.lastEventAt, startedAt + 10);

  opened.feed.close();
  tracker.close();
});

test("Shell running count tracks concurrent calls independently", () => {
  const tracker = new ActivityTracker(100);
  const startedAt = Date.now();

  tracker.started({ id: "a", tool: "bash", shellId: 9, cwd: "/workspace", startedAt });
  tracker.started({ id: "b", tool: "bash", shellId: 9, cwd: "/workspace", startedAt: startedAt + 1 });
  assert.equal(tracker.getShellActivity(9)?.runningCallCount, 2);

  tracker.finished({
    id: "a",
    tool: "bash",
    shellId: 9,
    cwd: "/workspace",
    startedAt,
    finishedAt: startedAt + 2,
    durationMs: 2,
    status: "success",
    payloadAvailable: true,
  });
  assert.equal(tracker.getShellActivity(9)?.runningCallCount, 1);

  tracker.finished({
    id: "b",
    tool: "bash",
    shellId: 9,
    cwd: "/workspace",
    startedAt: startedAt + 1,
    finishedAt: startedAt + 3,
    durationMs: 2,
    status: "success",
    payloadAvailable: true,
  });
  assert.equal(tracker.getShellActivity(9)?.runningCallCount, 0);
  assert.equal(tracker.getShellActivity(9)?.lastEventAt, startedAt + 3);

  tracker.close();
});

test("activity feed closes when pending events exceed its bounded queue", async () => {
  const tracker = new ActivityTracker(100, 10, 2);
  const opened = tracker.openFeed();

  tracker.started({ id: "1", tool: "read", cwd: "/workspace", startedAt: 1 });
  tracker.started({ id: "2", tool: "read", cwd: "/workspace", startedAt: 2 });
  tracker.started({ id: "3", tool: "read", cwd: "/workspace", startedAt: 3 });

  const first = await opened.feed.next();
  const second = await opened.feed.next();
  const done = await opened.feed.next();

  assert.equal(first?.call.id, "1");
  assert.equal(second?.call.id, "2");
  assert.equal(done, null);

  tracker.close();
});

test("completed-call retention also retires stale workspace projection state", () => {
  const tracker = new ActivityTracker(1, 10);

  tracker.finished({
    id: "old",
    tool: "read",
    cwd: "/old",
    startedAt: 1,
    finishedAt: 2,
    durationMs: 1,
    status: "success",
    payloadAvailable: true,
  });
  tracker.finished({
    id: "new",
    tool: "read",
    cwd: "/new",
    startedAt: 3,
    finishedAt: 4,
    durationMs: 1,
    status: "success",
    payloadAvailable: true,
  });

  assert.equal(tracker.getCall("old"), undefined);
  assert.deepEqual(tracker.snapshot().workspaces.map((item) => item.cwd), ["/new"]);

  tracker.close();
});

test("snapshot keeps shell activity facts beyond the per-workspace recent-call window", () => {
  const tracker = new ActivityTracker(100, 2);
  const base = Date.now();

  tracker.finished({
    id: "shell-1",
    tool: "read",
    shellId: 1,
    cwd: "/workspace",
    startedAt: base + 1,
    finishedAt: base + 2,
    durationMs: 1,
    status: "success",
    payloadAvailable: true,
  });
  tracker.finished({
    id: "shell-2-a",
    tool: "read",
    shellId: 2,
    cwd: "/workspace",
    startedAt: base + 3,
    finishedAt: base + 4,
    durationMs: 1,
    status: "success",
    payloadAvailable: true,
  });
  tracker.finished({
    id: "shell-2-b",
    tool: "edit",
    shellId: 2,
    cwd: "/workspace",
    startedAt: base + 5,
    finishedAt: base + 6,
    durationMs: 1,
    status: "success",
    payloadAvailable: true,
  });

  const workspace = tracker.snapshot().workspaces[0]!;
  assert.deepEqual(workspace.recentCalls.map((call) => call.id), ["shell-2-b", "shell-2-a"]);
  assert.deepEqual(workspace.recentShells.map((shell) => shell.shellId), [2, 1]);

  tracker.close();
});

test("snapshot protects running calls from newer completed calls in the recent window", () => {
  const tracker = new ActivityTracker(100, 2);

  tracker.started({
    id: "running",
    tool: "bash",
    shellId: 1,
    cwd: "/workspace",
    startedAt: 1,
  });
  tracker.finished({
    id: "done-1",
    tool: "read",
    shellId: 1,
    cwd: "/workspace",
    startedAt: 10,
    finishedAt: 11,
    durationMs: 1,
    status: "success",
    payloadAvailable: true,
  });
  tracker.finished({
    id: "done-2",
    tool: "edit",
    shellId: 1,
    cwd: "/workspace",
    startedAt: 20,
    finishedAt: 21,
    durationMs: 1,
    status: "success",
    payloadAvailable: true,
  });

  const workspace = tracker.snapshot().workspaces[0]!;
  assert.deepEqual(workspace.recentCalls.map((call) => call.id), ["running", "done-2"]);
  assert.equal(workspace.recentShells[0]?.runningCallCount, 1);

  tracker.close();
});
