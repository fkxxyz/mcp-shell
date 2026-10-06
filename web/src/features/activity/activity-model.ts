import type {
  ActivitySnapshotDto,
  ActivityWorkspaceDto,
  ToolCallSummaryDto,
} from "../../../../src/contracts/activity";

const ACTIVE_WINDOW_MS = 10 * 60 * 1000;
const MAX_RECENT_CALLS = 10;
export const ACTIVITY_CARD_ROWS = 5;

type ActivityShellState = {
  shellId: number;
  lastEventAt: number;
  runningCount: number;
};

type ActivityWorkspaceState = {
  cwd: string;
  lastEventAt: number;
  runningCount: number;
  recentCalls: ToolCallSummaryDto[];
  recentShells: ActivityShellState[];
};

export type ActivityWorkspaceView = {
  cwd: string;
  lastEventAt: number;
  runningCount: number;
  activeShellCount: number;
  visibleCalls: ToolCallSummaryDto[];
};

export type ActivityView = {
  now: number;
  summary: {
    activeWorkspaceCount: number;
    activeShellCount: number;
    runningCallCount: number;
  };
  active: ActivityWorkspaceView[];
  earlier: ActivityWorkspaceView[];
};

const EMPTY_VIEW: ActivityView = {
  now: Date.now(),
  summary: {
    activeWorkspaceCount: 0,
    activeShellCount: 0,
    runningCallCount: 0,
  },
  active: [],
  earlier: [],
};

export class ActivityStore {
  private readonly workspaces = new Map<string, ActivityWorkspaceState>();
  private activeOrder: string[] = [];
  private earlierOrder: string[] = [];
  private clockOffset = 0;
  private readonly listeners = new Set<() => void>();
  private current: ActivityView = EMPTY_VIEW;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ActivityView => this.current;

  replaceSnapshot(snapshot: ActivitySnapshotDto): void {
    const serverTime = Date.parse(snapshot.server_time);
    this.clockOffset = Number.isFinite(serverTime) ? serverTime - Date.now() : 0;
    const now = this.now();

    this.workspaces.clear();
    this.activeOrder = [];
    this.earlierOrder = [];

    for (const item of snapshot.workspaces ?? []) {
      const workspace = fromDto(item, now);
      this.workspaces.set(workspace.cwd, workspace);
      if (this.isActive(workspace, now)) this.activeOrder.push(workspace.cwd);
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
        recentShells: [],
      };
      this.workspaces.set(call.cwd, workspace);
    }

    const now = this.now();
    const wasActive = existed && this.isActive(workspace, now);
    const existingIndex = workspace.recentCalls.findIndex((item) => item.id === call.id);
    const previous = existingIndex >= 0 ? workspace.recentCalls[existingIndex] : undefined;

    if (call.status === "running") {
      if (!previous || previous.status !== "running") workspace.runningCount += 1;
    } else if (previous?.status === "running") {
      workspace.runningCount = Math.max(0, workspace.runningCount - 1);
    } else if (!previous && workspace.runningCount > 0) {
      workspace.runningCount -= 1;
    }

    updateShellActivity(workspace, call, previous);

    const merged = existingIndex >= 0
      ? workspace.recentCalls.map((item, index) => index === existingIndex ? call : item)
      : [call, ...workspace.recentCalls];
    workspace.recentCalls = retainRecentCalls(merged, MAX_RECENT_CALLS);

    const eventAt = callEventAt(call);
    if (Number.isFinite(eventAt)) workspace.lastEventAt = Math.max(workspace.lastEventAt, eventAt);

    const nowActive = this.isActive(workspace, now);
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
    const now = this.now();
    this.pruneInactiveShells(now);

    const expired = this.activeOrder
      .map((cwd) => this.workspaces.get(cwd))
      .filter((workspace): workspace is ActivityWorkspaceState => Boolean(workspace && !this.isActive(workspace, now)));

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

  private isActive(workspace: ActivityWorkspaceState, now: number): boolean {
    return workspace.runningCount > 0 || now - workspace.lastEventAt < ACTIVE_WINDOW_MS;
  }

  private pruneInactiveShells(now: number): void {
    for (const workspace of this.workspaces.values()) {
      workspace.recentShells = workspace.recentShells.filter((shell) => isShellActive(shell, now));
    }
  }

  private removeFromOrders(cwd: string): void {
    this.activeOrder = this.activeOrder.filter((item) => item !== cwd);
    this.earlierOrder = this.earlierOrder.filter((item) => item !== cwd);
  }

  private emit(): void {
    const now = this.now();
    this.pruneInactiveShells(now);

    const active = this.activeOrder
      .map((cwd) => this.workspaces.get(cwd))
      .filter(isDefined)
      .map((workspace) => toView(workspace, now));
    const earlier = this.earlierOrder
      .map((cwd) => this.workspaces.get(cwd))
      .filter(isDefined)
      .map((workspace) => toView(workspace, now));

    this.current = {
      now,
      summary: {
        activeWorkspaceCount: active.length,
        activeShellCount: active.reduce((sum, workspace) => sum + workspace.activeShellCount, 0),
        runningCallCount: active.reduce((sum, workspace) => sum + workspace.runningCount, 0),
      },
      active,
      earlier,
    };

    for (const listener of this.listeners) listener();
  }
}

function fromDto(item: ActivityWorkspaceDto, now: number): ActivityWorkspaceState {
  return {
    cwd: item.cwd,
    lastEventAt: Date.parse(item.last_event_at),
    runningCount: Number(item.running_call_count) || 0,
    recentCalls: retainRecentCalls(item.recent_calls ?? [], MAX_RECENT_CALLS),
    recentShells: (item.recent_shells ?? [])
      .map((shell) => ({
        shellId: shell.shell_id,
        lastEventAt: Date.parse(shell.last_event_at),
        runningCount: Number(shell.running_call_count) || 0,
      }))
      .filter((shell) => Number.isFinite(shell.lastEventAt) && isShellActive(shell, now)),
  };
}

function updateShellActivity(
  workspace: ActivityWorkspaceState,
  call: ToolCallSummaryDto,
  previous: ToolCallSummaryDto | undefined,
): void {
  if (call.shell_id == null) return;

  let shell = workspace.recentShells.find((item) => item.shellId === call.shell_id);
  if (!shell) {
    shell = {
      shellId: call.shell_id,
      lastEventAt: 0,
      runningCount: 0,
    };
    workspace.recentShells.push(shell);
  }

  if (call.status === "running") {
    if (!previous || previous.status !== "running") shell.runningCount += 1;
  } else if (previous?.status === "running" && previous.shell_id === call.shell_id) {
    shell.runningCount = Math.max(0, shell.runningCount - 1);
  } else if (!previous && shell.runningCount > 0) {
    shell.runningCount -= 1;
  }

  const eventAt = callEventAt(call);
  if (Number.isFinite(eventAt)) shell.lastEventAt = Math.max(shell.lastEventAt, eventAt);
}

function toView(workspace: ActivityWorkspaceState, now: number): ActivityWorkspaceView {
  return {
    cwd: workspace.cwd,
    lastEventAt: workspace.lastEventAt,
    runningCount: workspace.runningCount,
    activeShellCount: workspace.recentShells.filter((shell) => isShellActive(shell, now)).length,
    visibleCalls: workspace.recentCalls.slice(0, ACTIVITY_CARD_ROWS),
  };
}

function isShellActive(shell: ActivityShellState, now: number): boolean {
  return shell.runningCount > 0 || now - shell.lastEventAt < ACTIVE_WINDOW_MS;
}

function retainRecentCalls(calls: ToolCallSummaryDto[], limit: number): ToolCallSummaryDto[] {
  const byId = new Map<string, ToolCallSummaryDto>();
  for (const call of calls) byId.set(call.id, call);

  const running: ToolCallSummaryDto[] = [];
  const completed: ToolCallSummaryDto[] = [];
  for (const call of byId.values()) {
    (call.status === "running" ? running : completed).push(call);
  }

  running.sort((a, b) => compareTime(b.started_at, a.started_at) || b.id.localeCompare(a.id));
  completed.sort((a, b) => compareTime(
    b.finished_at ?? b.started_at,
    a.finished_at ?? a.started_at,
  ) || b.id.localeCompare(a.id));

  return [...running, ...completed].slice(0, limit);
}

function callEventAt(call: ToolCallSummaryDto): number {
  return Date.parse(call.finished_at ?? call.started_at);
}

function compareTime(a: string, b: string): number {
  const aTime = Date.parse(a);
  const bTime = Date.parse(b);
  return (Number.isFinite(aTime) ? aTime : 0) - (Number.isFinite(bTime) ? bTime : 0);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
