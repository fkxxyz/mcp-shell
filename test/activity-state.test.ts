import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Browser module is intentionally plain JavaScript without a TS build step.
import { ActivityState } from "../web/js/activity-state.js";

test("activity state keeps active order stable, promotes from earlier, and expires by tier", () => {
  let latest: any;
  const state = new ActivityState((view: any) => {
    latest = view;
  });

  const base = Date.now();
  state.replaceSnapshot({
    server_time: new Date(base).toISOString(),
    workspaces: [
      workspace("/a", base - 1_000),
      workspace("/b", base - 2_000),
      workspace("/c", base - 20 * 60_000),
    ],
  });

  assert.deepEqual(latest.active.map((item: any) => item.cwd), ["/a", "/b"]);
  assert.deepEqual(latest.earlier.map((item: any) => item.cwd), ["/c"]);

  state.applyCall(call("b-new", "/b", base + 2_000));
  assert.deepEqual(latest.active.map((item: any) => item.cwd), ["/a", "/b"], "activity inside ACTIVE must not reorder");

  state.applyCall(call("c-new", "/c", base + 3_000));
  assert.deepEqual(latest.active.map((item: any) => item.cwd), ["/c", "/a", "/b"], "EARLIER promotion enters ACTIVE front");

  state.clockOffset += 11 * 60_000;
  assert.equal(state.expire(), true);
  assert.deepEqual(latest.active, []);
  assert.deepEqual(latest.earlier.map((item: any) => item.cwd), ["/c", "/b", "/a"]);
});

test("running workspace remains active regardless of last event age", () => {
  let latest: any;
  const state = new ActivityState((view: any) => {
    latest = view;
  });

  const base = Date.now();
  state.replaceSnapshot({
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

  state.clockOffset += 24 * 60 * 60_000;
  assert.equal(state.expire(), false);
  assert.deepEqual(latest.active.map((item: any) => item.cwd), ["/running"]);
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
    status: "success",
    payload_available: true,
  };
}
