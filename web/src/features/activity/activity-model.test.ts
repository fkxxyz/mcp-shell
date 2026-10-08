import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityCallEventDto, ToolCallSummaryDto } from "../../../../src/contracts/observability";
import { ACTIVITY_CARD_ROWS, ActivityStore, mergeShellCallViews } from "./activity-model";

const UI_FIXTURE_WINDOW_MS = 60_000;

describe("ActivityStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps active order stable, promotes from earlier, and expires by server-provided deadlines", () => {
    vi.useFakeTimers();
    const base = new Date("2026-10-06T08:00:00.000Z").getTime();
    vi.setSystemTime(base);
    const store = new ActivityStore();

    store.replaceSnapshot({
      server_time: new Date(base).toISOString(),
      active_window_ms: UI_FIXTURE_WINDOW_MS,
      workspaces: [
        workspace("/a", base - 1_000),
        workspace("/b", base - 2_000),
        workspace("/c", base - 20 * 60_000),
      ],
    });

    expect(store.getSnapshot().active.map((item) => item.cwd)).toEqual(["/a", "/b"]);
    expect(store.getSnapshot().earlier.map((item) => item.cwd)).toEqual(["/c"]);

    store.applyCall(activityEvent(call("b-new", "/b", base + 2_000)));
    expect(store.getSnapshot().active.map((item) => item.cwd)).toEqual(["/a", "/b"]);

    store.applyCall(activityEvent(call("c-new", "/c", base + 3_000)));
    expect(store.getSnapshot().active.map((item) => item.cwd)).toEqual(["/c", "/a", "/b"]);

    vi.setSystemTime(base + 2 * 60_000);
    expect(store.tick()).toBe(true);
    expect(store.getSnapshot().active).toEqual([]);
    expect(store.getSnapshot().earlier.map((item) => item.cwd)).toEqual(["/c", "/b", "/a"]);
  });

  it("keeps snapshot clock calibration when a delayed live event arrives", () => {
    vi.useFakeTimers();
    const clientBase = new Date("2026-10-06T08:00:00.000Z").getTime();
    const serverBase = clientBase + 60_000;
    vi.setSystemTime(clientBase);
    const store = new ActivityStore();

    store.replaceSnapshot({
      server_time: new Date(serverBase).toISOString(),
      active_window_ms: UI_FIXTURE_WINDOW_MS,
      workspaces: [{
        ...workspace("/work", serverBase),
        active_until: new Date(serverBase + 30_000).toISOString(),
      }],
    });

    const event = activityEvent(call("delayed", "/work", serverBase + 1_000));
    event.server_time = new Date(serverBase - 2 * 60_000).toISOString();
    event.workspace_activity!.active_until = new Date(serverBase + 30_000).toISOString();
    event.shell_activity!.active_until = new Date(serverBase + 30_000).toISOString();
    store.applyCall(event);

    vi.setSystemTime(clientBase + 31_000);
    expect(store.tick()).toBe(true);
    expect(store.getSnapshot().active).toEqual([]);
  });

  it("keeps running workspaces and shells active regardless of last-event age", () => {
    vi.useFakeTimers();
    const base = new Date("2026-10-06T08:00:00.000Z").getTime();
    vi.setSystemTime(base);
    const store = new ActivityStore();

    store.replaceSnapshot({
      server_time: new Date(base).toISOString(),
      active_window_ms: UI_FIXTURE_WINDOW_MS,
      workspaces: [{
        ...workspace("/running", base - 60 * 60_000),
        running_call_count: 1,
        active: true,
        active_until: null,
        recent_calls: [{
          id: "running",
          client_name: null,
          client_session_id: null,
          shell_id: 1,
          cwd: "/running",
          tool: "bash",
          input_preview: { command: "sleep 3600", shell_id: 1 },
          started_at: new Date(base - 60 * 60_000).toISOString(),
          finished_at: null,
          duration_ms: null,
          status: "running",
          payload_available: false,
        }],
        recent_shells: [{
          shell_id: 1,
          last_event_at: new Date(base - 60 * 60_000).toISOString(),
          running_call_count: 1,
          active: true,
          active_until: null,
        }],
      }],
    });

    vi.setSystemTime(base + 24 * 60 * 60_000);
    expect(store.tick()).toBe(false);
    expect(store.getSnapshot().active.map((item) => item.cwd)).toEqual(["/running"]);
    expect(store.getSnapshot().summary.activeShellCount).toBe(1);
  });

  it("derives active workspace, shell, and running-call counts from server presence facts", () => {
    vi.useFakeTimers();
    const base = new Date("2026-10-06T08:00:00.000Z").getTime();
    vi.setSystemTime(base);
    const store = new ActivityStore();

    store.replaceSnapshot({
      server_time: new Date(base).toISOString(),
      active_window_ms: UI_FIXTURE_WINDOW_MS,
      workspaces: [
        {
          ...workspace("/a", base - 1_000),
          running_call_count: 2,
          active: true,
          active_until: null,
          recent_shells: [
            shell(1, base - 2_000),
            shell(2, base - 60 * 60_000, 1),
          ],
        },
        {
          ...workspace("/b", base - 2_000),
          recent_shells: [shell(3, base - 3_000)],
        },
        {
          ...workspace("/earlier", base - 60 * 60_000),
          recent_shells: [shell(4, base - 60 * 60_000)],
        },
      ],
    });

    expect(store.getSnapshot().summary).toEqual({
      activeWorkspaceCount: 2,
      activeShellCount: 3,
      runningCallCount: 2,
    });
  });

  it("shows at most five current-and-recent calls with running calls protected from recency eviction", () => {
    vi.useFakeTimers();
    const base = new Date("2026-10-06T08:00:00.000Z").getTime();
    vi.setSystemTime(base);
    const store = new ActivityStore();

    const running: ToolCallSummaryDto = {
      id: "long-running",
      client_name: null,
      client_session_id: null,
      shell_id: 1,
      cwd: "/work",
      tool: "bash",
      input_preview: { command: "sleep 60", shell_id: 1 },
      started_at: new Date(base - 60_000).toISOString(),
      finished_at: null,
      duration_ms: null,
      status: "running",
      payload_available: false,
    };
    const completed = Array.from({ length: 6 }, (_, index) => (
      call(`done-${index}`, "/work", base - index * 1_000)
    ));

    store.replaceSnapshot({
      server_time: new Date(base).toISOString(),
      active_window_ms: UI_FIXTURE_WINDOW_MS,
      workspaces: [{
        ...workspace("/work", base),
        running_call_count: 1,
        active: true,
        active_until: null,
        recent_calls: [running, ...completed],
        recent_shells: [shell(1, base, 1)],
      }],
    });

    const visible = store.getSnapshot().active[0]!.visibleCalls;
    expect(visible).toHaveLength(ACTIVITY_CARD_ROWS);
    expect(visible[0]?.call.id).toBe("long-running");
    expect(visible.slice(1).map((item) => item.call.id)).toEqual([
      "done-0",
      "done-1",
      "done-2",
      "done-3",
    ]);
  });

  it("treats snapshots as a quiet baseline and revisions only live call events", () => {
    vi.useFakeTimers();
    const base = new Date("2026-10-06T08:00:00.000Z").getTime();
    vi.setSystemTime(base);
    const store = new ActivityStore();
    const existing = call("existing", "/work", base - 1_000);

    store.replaceSnapshot({
      server_time: new Date(base).toISOString(),
      active_window_ms: UI_FIXTURE_WINDOW_MS,
      workspaces: [{
        ...workspace("/work", base - 999),
        recent_calls: [existing],
        recent_shells: [shell(1, base - 999)],
      }],
    });

    expect(store.getSnapshot().active[0]!.visibleCalls[0]!.updateRevision).toBe(0);
    expect(store.getShellCalls(1)[0]!.updateRevision).toBe(0);

    const running = runningCall("live", "/work", base + 1_000);
    store.applyCall(activityEvent(running));
    expect(store.getShellCalls(1).find((item) => item.call.id === "live")?.updateRevision).toBe(1);

    const finishedCall: ToolCallSummaryDto = {
      ...running,
      finished_at: new Date(base + 2_000).toISOString(),
      duration_ms: 1_000,
      status: "success",
      payload_available: true,
    };
    store.applyCall(activityEvent(finishedCall));
    const finished = store.getShellCalls(1).find((item) => item.call.id === "live");
    expect(finished?.updateRevision).toBe(2);
    expect(finished?.call.status).toBe("success");
  });

  it("projects bounded live calls by shell without leaking calls from sibling shells", () => {
    const base = new Date("2026-10-06T08:00:00.000Z").getTime();
    const store = new ActivityStore();
    const shellOne = runningCall("shell-one", "/work", base, 1);
    const shellTwo = runningCall("shell-two", "/work", base + 1, 2);

    store.applyCall(activityEvent(shellOne));
    store.applyCall(activityEvent(shellTwo));

    expect(store.getShellCalls(1).map((item) => item.call.id)).toEqual(["shell-one"]);
    expect(store.getShellCalls(2).map((item) => item.call.id)).toEqual(["shell-two"]);
  });

  it("keeps the Shell-call projection stable across time-only ticks", () => {
    vi.useFakeTimers();
    const base = new Date("2026-10-06T08:00:00.000Z").getTime();
    vi.setSystemTime(base);
    const store = new ActivityStore();

    store.applyCall(activityEvent(runningCall("running", "/work", base)));
    const before = store.getShellCalls(1);

    vi.setSystemTime(base + 15_000);
    store.tick();

    expect(store.getShellCalls(1)).toBe(before);
  });
});

describe("mergeShellCallViews", () => {
  it("keeps running calls first and returns completed duplicates to history authority", () => {
    const base = new Date("2026-10-06T08:00:00.000Z").getTime();
    const history = call("same", "/work", base - 2_000);
    const liveFinished = {
      ...history,
      finished_at: new Date(base).toISOString(),
      duration_ms: 2_000,
      status: "error" as const,
    };
    const running = runningCall("running", "/work", base + 1_000);

    const merged = mergeShellCallViews(
      [history],
      [
        { call: liveFinished, updateRevision: 2 },
        { call: running, updateRevision: 1 },
      ],
    );

    expect(merged.map((item) => item.call.id)).toEqual(["running", "same"]);
    expect(merged[1]?.call.status).toBe("success");
    expect(merged[1]?.updateRevision).toBe(2);
  });

  it("shows a live completed call until refreshed history contains it", () => {
    const base = new Date("2026-10-06T08:00:00.000Z").getTime();
    const finished = call("just-finished", "/work", base);

    const merged = mergeShellCallViews(
      [],
      [{ call: finished, updateRevision: 2 }],
    );

    expect(merged).toEqual([{ call: finished, updateRevision: 2 }]);
  });
});

function workspace(cwd: string, lastEventAt: number) {
  const activeUntil = lastEventAt + UI_FIXTURE_WINDOW_MS;
  return {
    cwd,
    last_event_at: new Date(lastEventAt).toISOString(),
    running_call_count: 0,
    active: true,
    active_until: new Date(activeUntil).toISOString(),
    recent_calls: [],
    recent_shells: [],
  };
}

function shell(shellId: number, lastEventAt: number, runningCallCount = 0) {
  return {
    shell_id: shellId,
    last_event_at: new Date(lastEventAt).toISOString(),
    running_call_count: runningCallCount,
    active: true,
    active_until: runningCallCount > 0
      ? null
      : new Date(lastEventAt + UI_FIXTURE_WINDOW_MS).toISOString(),
  };
}

function activityEvent(call: ToolCallSummaryDto): ActivityCallEventDto {
  const eventAt = Date.parse(call.finished_at ?? call.started_at);
  const running = call.status === "running";
  const activeUntil = running ? null : new Date(eventAt + UI_FIXTURE_WINDOW_MS).toISOString();
  return {
    call,
    server_time: new Date(eventAt).toISOString(),
    workspace_activity: call.cwd ? {
      cwd: call.cwd,
      last_event_at: new Date(eventAt).toISOString(),
      running_call_count: running ? 1 : 0,
      active: true,
      active_until: activeUntil,
    } : null,
    shell_activity: call.shell_id == null ? null : {
      shell_id: call.shell_id,
      last_event_at: new Date(eventAt).toISOString(),
      running_call_count: running ? 1 : 0,
      active: true,
      active_until: activeUntil,
    },
  };
}

function call(id: string, cwd: string, at: number): ToolCallSummaryDto {
  return {
    id,
    client_name: null,
    client_session_id: null,
    shell_id: 1,
    cwd,
    tool: "read",
    input_preview: { path: "file.txt", shell_id: 1 },
    started_at: new Date(at).toISOString(),
    finished_at: new Date(at + 1).toISOString(),
    duration_ms: 1,
    status: "success",
    payload_available: true,
  };
}

function runningCall(id: string, cwd: string, at: number, shellId = 1): ToolCallSummaryDto {
  return {
    id,
    client_name: null,
    client_session_id: null,
    shell_id: shellId,
    cwd,
    tool: "bash",
    input_preview: { command: "sleep 1", shell_id: shellId },
    started_at: new Date(at).toISOString(),
    finished_at: null,
    duration_ms: null,
    status: "running",
    payload_available: false,
  };
}
