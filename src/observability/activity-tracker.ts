import { deriveActivityPresence } from "./activity-policy.js";
import type {
  FinishedToolCallSummary,
  RunningToolCall,
  ToolCallSummary,
} from "./tool-call.js";

export type ActivityEvent = {
  type: "tool_call.started" | "tool_call.finished";
  call: ToolCallSummary;
  serverTime: number;
  workspaceActivity: Pick<WorkspaceSnapshot, "cwd" | "lastEventAt" | "runningCallCount"> | null;
  shellActivity: ShellActivitySnapshot | null;
};

export type WorkspaceSnapshot = {
  cwd: string;
  lastEventAt: number;
  runningCallCount: number;
  recentCalls: ToolCallSummary[];
  recentShells: WorkspaceShellActivity[];
};

export type WorkspaceShellActivity = {
  shellId: number;
  lastEventAt: number;
  runningCallCount: number;
};

export type ShellActivitySnapshot = WorkspaceShellActivity & {
  cwd: string;
};

export type ActivitySnapshot = {
  serverTime: number;
  workspaces: WorkspaceSnapshot[];
};

type WorkspaceState = {
  cwd: string;
  lastEventAt: number;
  running: Map<string, ToolCallSummary>;
  recent: ToolCallSummary[];
};

type ShellActivityState = ShellActivitySnapshot;

export class ActivityTracker {
  private readonly workspaces = new Map<string, WorkspaceState>();
  private readonly running = new Map<string, ToolCallSummary>();
  private readonly completed: ToolCallSummary[] = [];
  private readonly byId = new Map<string, ToolCallSummary>();
  private readonly shellActivity = new Map<number, ShellActivityState>();
  private readonly subscribers = new Set<ActivityFeed>();
  private readonly maxRecentPerWorkspace: number;
  private lastPresencePruneAt = 0;

  constructor(
    private readonly maxCompleted: number,
    maxRecentPerWorkspace = 10,
    private readonly maxPendingPerSubscriber = 256,
  ) {
    this.maxRecentPerWorkspace = Math.min(maxRecentPerWorkspace, maxCompleted);
  }

  bootstrap(calls: FinishedToolCallSummary[]): void {
    for (const call of calls) this.applyFinished(call, false);
  }

  bootstrapShellActivity(shells: ShellActivitySnapshot[]): void {
    for (const shell of shells) {
      const existing = this.shellActivity.get(shell.shellId);
      if (!existing || shell.lastEventAt > existing.lastEventAt) {
        this.shellActivity.set(shell.shellId, { ...shell, runningCallCount: 0 });
      }

      const workspace = this.workspace(shell.cwd);
      workspace.lastEventAt = Math.max(workspace.lastEventAt, shell.lastEventAt);
    }
  }

  started(call: RunningToolCall): void {
    const summary: ToolCallSummary = {
      ...call,
      status: "running",
    };
    this.running.set(call.id, summary);
    this.byId.set(call.id, summary);

    if (call.cwd) {
      const workspace = this.workspace(call.cwd);
      workspace.running.set(call.id, summary);
      workspace.lastEventAt = Math.max(workspace.lastEventAt, call.startedAt);
    }

    this.applyShellStarted(summary);
    this.maybePrunePresence(call.startedAt);
    this.publish(this.lifecycleEvent("tool_call.started", summary));
  }

  finished(call: FinishedToolCallSummary): void {
    this.applyFinished(call, true);
  }

  markCallsEvicted(callIds: string[]): void {
    if (callIds.length === 0) return;
    const evicted = new Set(callIds);
    for (const summary of this.completed) {
      if (evicted.has(summary.id)) summary.payloadAvailable = false;
    }
  }

  snapshot(): ActivitySnapshot {
    const serverTime = Date.now();
    this.prunePresence(serverTime);
    const recentShellsByWorkspace = this.recentShellActivity();
    const workspaces = [...this.workspaces.values()]
      .map((workspace) => {
        const running = [...workspace.running.values()].sort(compareRunningCalls);
        const completed = [...workspace.recent].sort(compareCompletedCalls);
        const recentCalls = [...running, ...completed]
          .slice(0, this.maxRecentPerWorkspace)
          .map(cloneSummary);
        return {
          cwd: workspace.cwd,
          lastEventAt: workspace.lastEventAt,
          runningCallCount: workspace.running.size,
          recentCalls,
          recentShells: recentShellsByWorkspace.get(workspace.cwd) ?? [],
        };
      })
      .sort((a, b) => b.lastEventAt - a.lastEventAt || a.cwd.localeCompare(b.cwd));

    return { serverTime, workspaces };
  }

  openFeed(): { snapshot: ActivitySnapshot; feed: ActivityFeed } {
    const feed = new ActivityFeed(this.maxPendingPerSubscriber, () => {
      this.subscribers.delete(feed);
    });
    this.subscribers.add(feed);
    return { snapshot: this.snapshot(), feed };
  }

  getCall(id: string): ToolCallSummary | undefined {
    const call = this.byId.get(id);
    return call ? cloneSummary(call) : undefined;
  }

  getShellActivity(shellId: number): ShellActivitySnapshot | undefined {
    const shell = this.shellActivity.get(shellId);
    return shell ? { ...shell } : undefined;
  }

  close(): void {
    for (const subscriber of [...this.subscribers]) subscriber.close();
    this.subscribers.clear();
  }

  private recentShellActivity(): Map<string, WorkspaceShellActivity[]> {
    const byWorkspace = new Map<string, WorkspaceShellActivity[]>();

    for (const shell of this.shellActivity.values()) {
      const shells = byWorkspace.get(shell.cwd) ?? [];
      shells.push({
        shellId: shell.shellId,
        lastEventAt: shell.lastEventAt,
        runningCallCount: shell.runningCallCount,
      });
      byWorkspace.set(shell.cwd, shells);
    }

    for (const shells of byWorkspace.values()) {
      shells.sort((a, b) => b.lastEventAt - a.lastEventAt || b.shellId - a.shellId);
    }
    return byWorkspace;
  }

  private applyFinished(call: FinishedToolCallSummary, publish: boolean): void {
    this.running.delete(call.id);

    const existing = this.byId.get(call.id);
    const summary: ToolCallSummary = {
      id: call.id,
      tool: call.tool,
      shellId: call.shellId ?? existing?.shellId,
      cwd: call.cwd ?? existing?.cwd,
      inputPreview: call.inputPreview ?? existing?.inputPreview,
      startedAt: call.startedAt,
      finishedAt: call.finishedAt,
      durationMs: call.durationMs,
      status: call.status,
      payloadAvailable: call.payloadAvailable,
    };
    this.byId.set(call.id, summary);

    const previousIndex = this.completed.findIndex((item) => item.id === call.id);
    if (previousIndex >= 0) this.completed.splice(previousIndex, 1);
    insertNewestFirst(this.completed, summary);
    while (this.completed.length > this.maxCompleted) {
      const removed = this.completed.pop();
      if (removed && !this.running.has(removed.id)) {
        this.byId.delete(removed.id);
        this.retireFromWorkspace(removed);
      }
    }

    if (existing?.cwd && existing.cwd !== summary.cwd) {
      this.workspaces.get(existing.cwd)?.running.delete(call.id);
    }

    if (summary.cwd) {
      const workspace = this.workspace(summary.cwd);
      workspace.running.delete(call.id);
      workspace.lastEventAt = Math.max(workspace.lastEventAt, call.finishedAt);
      const recentIndex = workspace.recent.findIndex((item) => item.id === call.id);
      if (recentIndex >= 0) workspace.recent.splice(recentIndex, 1);
      workspace.recent.push(summary);
      workspace.recent.sort(compareCompletedCalls);
      if (workspace.recent.length > this.maxRecentPerWorkspace) {
        workspace.recent.length = this.maxRecentPerWorkspace;
      }
    } else if (existing?.cwd) {
      this.workspaces.get(existing.cwd)?.running.delete(call.id);
    }

    this.applyShellFinished(existing, summary);
    this.maybePrunePresence(call.finishedAt);
    if (publish) this.publish(this.lifecycleEvent("tool_call.finished", summary));
  }

  private lifecycleEvent(type: ActivityEvent["type"], call: ToolCallSummary): ActivityEvent {
    const workspace = call.cwd ? this.workspaces.get(call.cwd) : undefined;
    const shell = call.shellId == null ? undefined : this.shellActivity.get(call.shellId);
    return {
      type,
      call: cloneSummary(call),
      serverTime: Date.now(),
      workspaceActivity: workspace ? {
        cwd: workspace.cwd,
        lastEventAt: workspace.lastEventAt,
        runningCallCount: workspace.running.size,
      } : null,
      shellActivity: shell ? { ...shell } : null,
    };
  }

  private applyShellStarted(call: ToolCallSummary): void {
    if (call.shellId == null || !call.cwd) return;
    const shell = this.shellActivity.get(call.shellId) ?? {
      shellId: call.shellId,
      cwd: call.cwd,
      lastEventAt: 0,
      runningCallCount: 0,
    };
    shell.cwd = call.cwd;
    shell.lastEventAt = Math.max(shell.lastEventAt, call.startedAt);
    shell.runningCallCount += 1;
    this.shellActivity.set(call.shellId, shell);
  }

  private applyShellFinished(previous: ToolCallSummary | undefined, call: ToolCallSummary): void {
    if (call.shellId == null || !call.cwd) return;
    const shell = this.shellActivity.get(call.shellId) ?? {
      shellId: call.shellId,
      cwd: call.cwd,
      lastEventAt: 0,
      runningCallCount: 0,
    };
    shell.cwd = call.cwd;
    shell.lastEventAt = Math.max(shell.lastEventAt, call.finishedAt ?? call.startedAt);
    if (previous?.status === "running" && previous.shellId === call.shellId) {
      shell.runningCallCount = Math.max(0, shell.runningCallCount - 1);
    }
    this.shellActivity.set(call.shellId, shell);
  }

  private retireFromWorkspace(call: ToolCallSummary): void {
    if (!call.cwd) return;
    const workspace = this.workspaces.get(call.cwd);
    if (!workspace) return;

    const index = workspace.recent.findIndex((item) => item.id === call.id);
    if (index >= 0) workspace.recent.splice(index, 1);

    if (
      workspace.running.size === 0 &&
      workspace.recent.length === 0 &&
      !deriveActivityPresence(0, workspace.lastEventAt, Date.now()).active
    ) {
      this.workspaces.delete(call.cwd);
    }
  }

  private maybePrunePresence(now: number): void {
    if (now - this.lastPresencePruneAt < 60_000) return;
    this.prunePresence(now);
  }

  private prunePresence(now: number): void {
    this.lastPresencePruneAt = now;

    for (const [shellId, shell] of this.shellActivity) {
      if (!deriveActivityPresence(shell.runningCallCount, shell.lastEventAt, now).active) {
        this.shellActivity.delete(shellId);
      }
    }

    for (const [cwd, workspace] of this.workspaces) {
      if (
        workspace.running.size === 0 &&
        workspace.recent.length === 0 &&
        !deriveActivityPresence(0, workspace.lastEventAt, now).active
      ) {
        this.workspaces.delete(cwd);
      }
    }
  }

  private workspace(cwd: string): WorkspaceState {
    let workspace = this.workspaces.get(cwd);
    if (!workspace) {
      workspace = {
        cwd,
        lastEventAt: 0,
        running: new Map(),
        recent: [],
      };
      this.workspaces.set(cwd, workspace);
    }
    return workspace;
  }

  private publish(event: ActivityEvent): void {
    for (const subscriber of [...this.subscribers]) subscriber.push(event);
  }
}

export class ActivityFeed {
  private readonly queue: ActivityEvent[] = [];
  private waiter: ((event: ActivityEvent | null) => void) | undefined;
  private closed = false;

  constructor(
    private readonly maxPending: number,
    private readonly onClose: () => void,
  ) {}

  push(event: ActivityEvent): void {
    if (this.closed) return;

    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(event);
      return;
    }

    if (this.queue.length >= this.maxPending) {
      this.close();
      return;
    }

    this.queue.push(event);
  }

  next(): Promise<ActivityEvent | null> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(null);
    }
  }
}

function insertNewestFirst(items: ToolCallSummary[], call: ToolCallSummary): void {
  let index = 0;
  while (
    index < items.length &&
    (items[index]!.startedAt > call.startedAt ||
      (items[index]!.startedAt === call.startedAt && items[index]!.id > call.id))
  ) {
    index++;
  }
  items.splice(index, 0, call);
}

function compareRunningCalls(a: ToolCallSummary, b: ToolCallSummary): number {
  return b.startedAt - a.startedAt || b.id.localeCompare(a.id);
}

function compareCompletedCalls(a: ToolCallSummary, b: ToolCallSummary): number {
  const aEventAt = a.finishedAt ?? a.startedAt;
  const bEventAt = b.finishedAt ?? b.startedAt;
  return bEventAt - aEventAt || b.id.localeCompare(a.id);
}

function cloneSummary(call: ToolCallSummary): ToolCallSummary {
  return { ...call };
}
