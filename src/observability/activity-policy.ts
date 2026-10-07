export const ACTIVITY_ACTIVE_WINDOW_MS = 5 * 60 * 1000;

export type ActivityPresence = {
  active: boolean;
  activeUntil: number | null;
};

export function deriveActivityPresence(
  runningCallCount: number,
  lastEventAt: number | null,
  now: number,
): ActivityPresence {
  if (runningCallCount > 0) {
    return { active: true, activeUntil: null };
  }

  if (lastEventAt == null || !Number.isFinite(lastEventAt)) {
    return { active: false, activeUntil: null };
  }

  const activeUntil = lastEventAt + ACTIVITY_ACTIVE_WINDOW_MS;
  return {
    active: now < activeUntil,
    activeUntil,
  };
}
