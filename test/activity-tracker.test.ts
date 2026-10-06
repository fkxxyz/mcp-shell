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

  tracker.finished({
    id: "shell-1",
    tool: "read",
    shellId: 1,
    cwd: "/workspace",
    startedAt: 1,
    finishedAt: 2,
    durationMs: 1,
    status: "success",
    payloadAvailable: true,
  });
  tracker.finished({
    id: "shell-2-a",
    tool: "read",
    shellId: 2,
    cwd: "/workspace",
    startedAt: 3,
    finishedAt: 4,
    durationMs: 1,
    status: "success",
    payloadAvailable: true,
  });
  tracker.finished({
    id: "shell-2-b",
    tool: "edit",
    shellId: 2,
    cwd: "/workspace",
    startedAt: 5,
    finishedAt: 6,
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
