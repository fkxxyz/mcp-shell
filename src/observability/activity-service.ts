import { deriveActivityPresence, type ActivityPresence } from "./activity-policy.js";
import type { ShellActivitySnapshot } from "./activity-tracker.js";
import type { ObservabilityStore } from "./observability-store.js";
import type { ClientSessionKey, RunningToolCall, ToolCallIdentity } from "./tool-call.js";
type RunningShellCall = { shellId: number; cwd: string; startedAt: number };

export class ActivityUnavailableError extends Error {
  constructor() {
    super("Shell activity state is unavailable; restart after resolving the storage failure");
  }
}

/** Authoritative Shell presence and session membership, independent of call payloads. */
export class ActivityService {
  private readonly running = new Map<string, RunningShellCall>();
  private readonly runningByShell = new Map<number, Set<string>>();
  private unavailable = false;

  constructor(private readonly store: ObservabilityStore) {}

  started(call: RunningToolCall): void {
    if (call.shellId == null || !call.cwd || this.running.has(call.id)) return;
    const shellId = call.shellId;
    this.persistSafely(() => {
      const session = sessionKey(call);
      if (session) this.store.linkSessionShell(session, shellId);
    });
    this.running.set(call.id, { shellId, cwd: call.cwd, startedAt: call.startedAt });
    const calls = this.runningByShell.get(shellId) ?? new Set<string>();
    calls.add(call.id);
    this.runningByShell.set(shellId, calls);
  }

  finished(call: ToolCallIdentity & { finishedAt: number }): void {
    // Persistence and removal synchronously publish one transition to readers.
    const { shellId, cwd } = call;
    if (shellId != null && cwd) {
      this.persistSafely(() => this.store.recordShellActivity({
        shellId, cwd, lastEventAt: call.finishedAt,
      }, sessionKey(call)));
    }
    const previous = this.running.get(call.id);
    if (!previous) return;
    this.running.delete(call.id);
    const calls = this.runningByShell.get(previous.shellId)!;
    calls.delete(call.id);
    if (calls.size === 0) this.runningByShell.delete(previous.shellId);
  }

  getShellActivity(shellId: number): ShellActivitySnapshot | undefined {
    return this.read(() => {
      const persisted = this.store.getShellActivity(shellId);
      const calls = this.runningByShell.get(shellId);
      const first = calls?.values().next().value;
      const running = first ? this.running.get(first) : undefined;
      if (!persisted && !running) return undefined;
      let lastEventAt = persisted?.lastEventAt ?? 0;
      for (const id of calls ?? []) lastEventAt = Math.max(lastEventAt, this.running.get(id)!.startedAt);
      return {
        shellId, cwd: persisted?.cwd ?? running!.cwd, lastEventAt,
        runningCallCount: calls?.size ?? 0,
      };
    });
  }

  getSessionActivityForShell(shellId: number, now: number): ActivityPresence {
    return this.read(() => {
      // An indexed join returns distinct Shells of directly associated sessions.
      const members = this.store.listSessionShellActivity(shellId);
      let lastEventAt: number | null = null;
      let runningCallCount = 0;
      for (const member of members) {
        runningCallCount += this.runningByShell.get(member.shellId)?.size ?? 0;
        if (member.lastEventAt != null) {
          lastEventAt = Math.max(lastEventAt ?? member.lastEventAt, member.lastEventAt);
        }
      }
      return deriveActivityPresence(runningCallCount, lastEventAt, now);
    });
  }

  assertAvailable(): void {
    this.read(() => this.store.assertActivityAvailable());
  }

  private read<T>(read: () => T): T {
    if (this.unavailable) throw new ActivityUnavailableError();
    try {
      return read();
    } catch (error) {
      this.markUnavailable(error);
      throw new ActivityUnavailableError();
    }
  }

  private persistSafely(write: () => void): void {
    try {
      write();
    } catch (error) {
      // A later write cannot reconstruct lost associations. Remain degraded
      // for this process rather than returning an incomplete inactive result.
      this.markUnavailable(error);
    }
  }

  private markUnavailable(error: unknown): void {
    if (!this.unavailable) console.error("Failed to access Shell activity state:", error);
    this.unavailable = true;
  }
}

function sessionKey(call: ToolCallIdentity): ClientSessionKey | undefined {
  if (!call.clientName || !call.clientSessionId) return undefined;
  return { clientId: call.clientName, clientSessionId: call.clientSessionId };
}
