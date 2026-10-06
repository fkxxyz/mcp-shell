import type {
  FinishedToolCallSummary,
  RunningToolCall,
  ToolCallIndexEntry,
  ToolCallSummary,
} from "./tool-call.js";
import { summaryFromIndex } from "./tool-call.js";

export type ActivityEvent =
  | { type: "tool_call.started"; call: ToolCallSummary }
  | { type: "tool_call.finished"; call: ToolCallSummary };

export type WorkspaceSnapshot = {
  cwd: string;
  lastEventAt: number;
  runningCallCount: number;
  recentCalls: ToolCallSummary[];
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

export class ActivityTracker {
  private readonly workspaces = new Map<string, WorkspaceState>();
  private readonly running = new Map<string, ToolCallSummary>();
  private readonly completed: ToolCallSummary[] = [];
  private readonly byId = new Map<string, ToolCallSummary>();
  private readonly subscribers = new Set<ActivityFeed>();

  private readonly maxRecentPerWorkspace: number;

  constructor(
    private readonly maxCompleted: number,
    maxRecentPerWorkspace = 10,
    private readonly maxPendingPerSubscriber = 256,
  ) {
    this.maxRecentPerWorkspace = Math.min(maxRecentPerWorkspace, maxCompleted);
  }

  bootstrap(
    entries: ToolCallIndexEntry[],
    payloadAvailable: (entry: ToolCallIndexEntry) => boolean = () => true,
  ): void {
    for (const entry of entries) {
      const summary = summaryFromIndex(entry, payloadAvailable(entry));
      this.applyFinished(summary, false);
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

    this.publish({ type: "tool_call.started", call: cloneSummary(summary) });
  }

  finished(call: FinishedToolCallSummary): void {
    this.applyFinished(call, true);
  }

  markPayloadsEvicted(files: string[]): void {
    if (files.length === 0) return;
    const evicted = new Set(files);
    for (const summary of this.completed) {
      if (summary.payloadFile && evicted.has(summary.payloadFile)) {
        summary.payloadAvailable = false;
      }
    }
  }

  snapshot(): ActivitySnapshot {
    const workspaces = [...this.workspaces.values()]
      .map((workspace) => {
        const running = [...workspace.running.values()]
          .sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
        const recentCalls = [...running, ...workspace.recent]
          .slice(0, this.maxRecentPerWorkspace)
          .map(cloneSummary);
        return {
          cwd: workspace.cwd,
          lastEventAt: workspace.lastEventAt,
          runningCallCount: workspace.running.size,
          recentCalls,
        };
      })
      .sort((a, b) => b.lastEventAt - a.lastEventAt || a.cwd.localeCompare(b.cwd));

    return {
      serverTime: Date.now(),
      workspaces,
    };
  }

  openFeed(): { snapshot: ActivitySnapshot; feed: ActivityFeed } {
    const feed = new ActivityFeed(this.maxPendingPerSubscriber, () => {
      this.subscribers.delete(feed);
    });
    this.subscribers.add(feed);
    return { snapshot: this.snapshot(), feed };
  }

  listShellCalls(shellId: number, limit: number, beforeId?: string): ToolCallSummary[] {
    let start = 0;
    if (beforeId) {
      const index = this.completed.findIndex((call) => call.id === beforeId);
      if (index >= 0) start = index + 1;
    }

    const result: ToolCallSummary[] = [];
    for (let i = start; i < this.completed.length && result.length < limit; i++) {
      const call = this.completed[i]!;
      if (call.shellId === shellId) result.push(cloneSummary(call));
    }
    return result;
  }

  getCall(id: string): ToolCallSummary | undefined {
    const call = this.byId.get(id);
    return call ? cloneSummary(call) : undefined;
  }

  close(): void {
    for (const subscriber of [...this.subscribers]) subscriber.close();
    this.subscribers.clear();
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
      payloadFile: call.payloadFile,
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
      workspace.recent.unshift(summary);
      if (workspace.recent.length > this.maxRecentPerWorkspace) workspace.recent.length = this.maxRecentPerWorkspace;
    } else if (existing?.cwd) {
      this.workspaces.get(existing.cwd)?.running.delete(call.id);
    }

    if (publish) this.publish({ type: "tool_call.finished", call: cloneSummary(summary) });
  }

  private retireFromWorkspace(call: ToolCallSummary): void {
    if (!call.cwd) return;
    const workspace = this.workspaces.get(call.cwd);
    if (!workspace) return;

    const index = workspace.recent.findIndex((item) => item.id === call.id);
    if (index >= 0) workspace.recent.splice(index, 1);

    if (workspace.running.size === 0 && workspace.recent.length === 0) {
      this.workspaces.delete(call.cwd);
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

function cloneSummary(call: ToolCallSummary): ToolCallSummary {
  return { ...call };
}
