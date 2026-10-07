import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVITY_ACTIVE_WINDOW_MS,
  deriveActivityPresence,
} from "../src/observability/activity-policy.js";

test("activity presence expires exactly at the five-minute boundary", () => {
  const eventAt = Date.parse("2026-10-07T05:00:00.000Z");

  assert.deepEqual(
    deriveActivityPresence(0, eventAt, eventAt + ACTIVITY_ACTIVE_WINDOW_MS - 1),
    { active: true, activeUntil: eventAt + ACTIVITY_ACTIVE_WINDOW_MS },
  );
  assert.deepEqual(
    deriveActivityPresence(0, eventAt, eventAt + ACTIVITY_ACTIVE_WINDOW_MS),
    { active: false, activeUntil: eventAt + ACTIVITY_ACTIVE_WINDOW_MS },
  );
});

test("running activity stays active regardless of event age", () => {
  const now = Date.parse("2026-10-07T05:00:00.000Z");
  const dayAgo = now - 24 * 60 * 60 * 1000;

  assert.deepEqual(
    deriveActivityPresence(1, dayAgo, now),
    { active: true, activeUntil: null },
  );
});
