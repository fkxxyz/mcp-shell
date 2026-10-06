import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityStore } from "./activity-model";

describe("ActivityStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps active order stable, promotes from earlier, and expires by tier", () => {
    vi.useFakeTimers();
    const base = new Date("2026-10-06T08:00:00.000Z").getTime();
    vi.setSystemTime(base);
    const store = new ActivityStore();

    store.replaceSnapshot({
      server_time: new Date(base).toISOString(),
      workspaces: [
        workspace("/a", base - 1_000),
        workspace("/b", base - 2_000),
        workspace("/c", base - 20 * 60_000),
      ],
    });

    expect(store.getSnapshot().active.map((item) => item.cwd)).toEqual(["/a", "/b"]);
    expect(store.getSnapshot().earlier.map((item) => item.cwd)).toEqual(["/c"]);

    store.applyCall(call("b-new", "/b", base + 2_000));
    expect(store.getSnapshot().active.map((item) => item.cwd)).toEqual(["/a", "/b"]);

    store.applyCall(call("c-new", "/c", base + 3_000));
    expect(store.getSnapshot().active.map((item) => item.cwd)).toEqual(["/c", "/a", "/b"]);

    vi.setSystemTime(base + 11 * 60_000);
    expect(store.tick()).toBe(true);
    expect(store.getSnapshot().active).toEqual([]);
    expect(store.getSnapshot().earlier.map((item) => item.cwd)).toEqual(["/c", "/b", "/a"]);
  });

  it("keeps running workspaces active regardless of last-event age", () => {
    vi.useFakeTimers();
    const base = new Date("2026-10-06T08:00:00.000Z").getTime();
    vi.setSystemTime(base);
    const store = new ActivityStore();

    store.replaceSnapshot({
      server_time: new Date(base).toISOString(),
      workspaces: [{
        ...workspace("/running", base - 60 * 60_000),
        running_call_count: 1,
        recent_calls: [{
          id: "running",
          shell_id: 1,
          cwd: "/running",
          tool: "bash",
          started_at: new Date(base - 60 * 60_000).toISOString(),
          finished_at: null,
          duration_ms: null,
          status: "running",
          payload_available: false,
        }],
      }],
    });

    vi.setSystemTime(base + 24 * 60 * 60_000);
    expect(store.tick()).toBe(false);
    expect(store.getSnapshot().active.map((item) => item.cwd)).toEqual(["/running"]);
  });
});

function workspace(cwd: string, lastEventAt: number) {
  return {
    cwd,
    last_event_at: new Date(lastEventAt).toISOString(),
    running_call_count: 0,
    recent_calls: [],
  };
}

function call(id: string, cwd: string, at: number) {
  return {
    id,
    shell_id: 1,
    cwd,
    tool: "read",
    started_at: new Date(at).toISOString(),
    finished_at: new Date(at + 1).toISOString(),
    duration_ms: 1,
    status: "success" as const,
    payload_available: true,
  };
}
