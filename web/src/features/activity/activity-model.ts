import type {
  ActivitySnapshotDto,
  ActivityWorkspaceDto,
  ToolCallSummaryDto,
} from "../../../../src/contracts/activity";

const ACTIVE_WINDOW_MS = 10 * 60 * 1000;
const MAX_RECENT_CALLS = 10;

export type ActivityWorkspaceView = {
  cwd: string;
  lastEventAt: number;
  runningCount: number;
  recentCalls: ToolCallSummaryDto[];
};

export type ActivityView = {
  now: number;
  active: ActivityWorkspaceView[];
  earlier: ActivityWorkspaceView[];
};

export class ActivityStore {
  private readonly workspaces = new Map<string, ActivityWorkspaceView>();
  private activeOrder: string[] = [];
  private earlierOrder: string[] = [];
  private clockOffset = 0;
  private readonly listeners = new Set<() => void>();
  private current: ActivityView = { now: Date.now(), active: [], earlier: [] };

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ActivityView => this.current;

  replaceSnapshot(snapshot: ActivitySnapshotDto): void {
    const serverTime = Date.parse(snapshot.server_time);
    this.clockOffset = Number.isFinite(serverTime) ? serverTime - Date.now() : 0;

    this.workspaces.clear();
    this.activeOrder = [];
    this.earlierOrder = [];

    for (const item of snapshot.workspaces ?? []) {
      const workspace = fromDto(item);
      this.workspaces.set(workspace.cwd, workspace);
      if (this.isActive(workspace)) this.activeOrder.push(workspace.cwd);
      else this.earlierOrder.push(workspace.cwd);
    }

    this.emit();
  }

  applyCall(call: ToolCallSummaryDto): void {
    if (!call.cwd) return;

    let workspace = this.workspaces.get(call.cwd);
    const existed = Boolean(workspace);
    if (!workspace) {
      workspace = {
        cwd: call.cwd,
        lastEventAt: 0,
        runningCount: 0,
        recentCalls: [],
      };
      this.workspaces.set(call.cwd, workspace);
    }

    const wasActive = existed && this.isActive(workspace);
    const existingIndex = workspace.recentCalls.findIndex((item) => item.id === call.id);
    const previous = existingIndex >= 0 ? workspace.recentCalls[existingIndex] : undefined;

    if (call.status === "running") {
      if (!previous || previous.status !== "running") workspace.runningCount += 1;
    } else if (previous?.status === "running") {
      workspace.runningCount = Math.max(0, workspace.runningCount - 1);
    } else if (!previous && workspace.runningCount > 0) {
      workspace.runningCount -= 1;
    }

    if (existingIndex >= 0) workspace.recentCalls.splice(existingIndex, 1, call);
    else workspace.recentCalls.unshift(call);
    workspace.recentCalls = workspace.recentCalls
      .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
      .slice(0, MAX_RECENT_CALLS);

    const eventAt = Date.parse(call.finished_at || call.started_at);
    if (Number.isFinite(eventAt)) workspace.lastEventAt = Math.max(workspace.lastEventAt, eventAt);

    const nowActive = this.isActive(workspace);
    if (!wasActive && nowActive) {
      this.removeFromOrders(workspace.cwd);
      this.activeOrder.unshift(workspace.cwd);
    } else if (!existed) {
      this.removeFromOrders(workspace.cwd);
      (nowActive ? this.activeOrder : this.earlierOrder).unshift(workspace.cwd);
    }

    this.emit();
  }

  tick(): boolean {
    const expired = this.activeOrder
      .map((cwd) => this.workspaces.get(cwd))
      .filter((workspace): workspace is ActivityWorkspaceView => Boolean(workspace && !this.isActive(workspace)));

    if (expired.length > 0) {
      const expiredIds = new Set(expired.map((workspace) => workspace.cwd));
      this.activeOrder = this.activeOrder.filter((cwd) => !expiredIds.has(cwd));
      expired.sort((a, b) => b.lastEventAt - a.lastEventAt);
      this.earlierOrder = [
        ...expired.map((workspace) => workspace.cwd),
        ...this.earlierOrder.filter((cwd) => !expiredIds.has(cwd)),
      ];
    }

    this.emit();
    return expired.length > 0;
  }

  private now(): number {
    return Date.now() + this.clockOffset;
  }

  private isActive(workspace: ActivityWorkspaceView): boolean {
    return workspace.runningCount > 0 || this.now() - workspace.lastEventAt < ACTIVE_WINDOW_MS;
  }

  private removeFromOrders(cwd: string): void {
    this.activeOrder = this.activeOrder.filter((item) => item !== cwd);
    this.earlierOrder = this.earlierOrder.filter((item) => item !== cwd);
  }

  private emit(): void {
    this.current = {
      now: this.now(),
      active: this.activeOrder.map((cwd) => this.workspaces.get(cwd)).filter(isDefined),
      earlier: this.earlierOrder.map((cwd) => this.workspaces.get(cwd)).filter(isDefined),
    };
    for (const listener of this.listeners) listener();
  }
}

function fromDto(item: ActivityWorkspaceDto): ActivityWorkspaceView {
  return {
    cwd: item.cwd,
    lastEventAt: Date.parse(item.last_event_at),
    runningCount: Number(item.running_call_count) || 0,
    recentCalls: [...(item.recent_calls ?? [])],
  };
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
