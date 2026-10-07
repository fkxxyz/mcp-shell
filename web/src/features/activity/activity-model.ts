import type {
  ActivityCallEventDto,
  ActivityShellDto,
  ActivitySnapshotDto,
  ActivityWorkspaceDto,
  ActivityWorkspacePresenceDto,
  ToolCallSummaryDto,
} from "../../../../src/contracts/observability";

const MAX_RECENT_CALLS = 10;
export const ACTIVITY_CARD_ROWS = 5;
const EMPTY_SHELL_CALLS: ActivityCallView[] = [];

type ActivityShellState = {
  shellId: number;
  lastEventAt: number;
  runningCount: number;
  activeUntil: number | null;
};

type ActivityWorkspaceState = {
  cwd: string;
  lastEventAt: number;
  runningCount: number;
  activeUntil: number | null;
  recentCalls: ActivityCallView[];
  recentShells: ActivityShellState[];
};

export type ActivityCallView = {
  call: ToolCallSummaryDto;
  updateRevision: number;
};

export type ActivityWorkspaceView = {
  cwd: string;
  lastEventAt: number;
  runningCount: number;
  activeShellCount: number;
  visibleCalls: ActivityCallView[];
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
  private shellCalls = new Map<number, ActivityCallView[]>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ActivityView => this.current;

  getShellCalls(shellId: number): ActivityCallView[] {
    return this.shellCalls.get(shellId) ?? EMPTY_SHELL_CALLS;
  }

  replaceSnapshot(snapshot: ActivitySnapshotDto): void {
    this.updateClock(snapshot.server_time);
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

    this.refreshShellCalls();
    this.emit();
  }

  applyCall(event: ActivityCallEventDto): void {
    const call = event.call;
    if (!call.cwd) return;

    let workspace = this.workspaces.get(call.cwd);
    const existed = Boolean(workspace);
    if (!workspace) {
      workspace = {
        cwd: call.cwd,
        lastEventAt: 0,
        runningCount: 0,
        activeUntil: null,
        recentCalls: [],
        recentShells: [],
      };
      this.workspaces.set(call.cwd, workspace);
    }

    const now = this.now();
    const wasActive = existed && this.isActive(workspace, now);
    const existingIndex = workspace.recentCalls.findIndex((item) => item.call.id === call.id);
    const previousState = existingIndex >= 0 ? workspace.recentCalls[existingIndex] : undefined;

    const nextCall: ActivityCallView = {
      call,
      updateRevision: (previousState?.updateRevision ?? 0) + 1,
    };
    const merged = existingIndex >= 0
      ? workspace.recentCalls.map((item, index) => index === existingIndex ? nextCall : item)
      : [nextCall, ...workspace.recentCalls];
    workspace.recentCalls = retainRecentCalls(merged, MAX_RECENT_CALLS);

    if (event.workspace_activity) applyWorkspacePresence(workspace, event.workspace_activity);
    if (event.shell_activity) upsertShellPresence(workspace, event.shell_activity);

    const nowActive = this.isActive(workspace, now);
    if (!wasActive && nowActive) {
      this.removeFromOrders(workspace.cwd);
      this.activeOrder.unshift(workspace.cwd);
    } else if (!existed) {
      this.removeFromOrders(workspace.cwd);
      (nowActive ? this.activeOrder : this.earlierOrder).unshift(workspace.cwd);
    }

    this.refreshShellCalls();
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

  private updateClock(serverTimeValue: string): void {
    const serverTime = Date.parse(serverTimeValue);
    this.clockOffset = Number.isFinite(serverTime) ? serverTime - Date.now() : 0;
  }

  private now(): number {
    return Date.now() + this.clockOffset;
  }

  private isActive(workspace: ActivityWorkspaceState, now: number): boolean {
    return workspace.runningCount > 0 ||
      (workspace.activeUntil != null && now < workspace.activeUntil);
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

  private refreshShellCalls(): void {
    this.shellCalls = projectShellCalls(this.workspaces.values());
  }
}

function fromDto(item: ActivityWorkspaceDto, now: number): ActivityWorkspaceState {
  const workspace: ActivityWorkspaceState = {
    cwd: item.cwd,
    lastEventAt: parseTime(item.last_event_at) ?? 0,
    runningCount: Number(item.running_call_count) || 0,
    activeUntil: item.active ? parseTime(item.active_until) : null,
    recentCalls: retainRecentCalls(
      (item.recent_calls ?? []).map((call) => ({ call, updateRevision: 0 })),
      MAX_RECENT_CALLS,
    ),
    recentShells: (item.recent_shells ?? []).map(fromShellDto),
  };
  workspace.recentShells = workspace.recentShells.filter((shell) => isShellActive(shell, now));
  return workspace;
}

function applyWorkspacePresence(
  workspace: ActivityWorkspaceState,
  presence: ActivityWorkspacePresenceDto,
): void {
  workspace.lastEventAt = parseTime(presence.last_event_at) ?? workspace.lastEventAt;
  workspace.runningCount = Number(presence.running_call_count) || 0;
  workspace.activeUntil = presence.active ? parseTime(presence.active_until) : null;
}

function upsertShellPresence(workspace: ActivityWorkspaceState, presence: ActivityShellDto): void {
  const next = fromShellDto(presence);
  const index = workspace.recentShells.findIndex((shell) => shell.shellId === next.shellId);
  if (!presence.active) {
    if (index >= 0) workspace.recentShells.splice(index, 1);
    return;
  }
  if (index >= 0) workspace.recentShells[index] = next;
  else workspace.recentShells.push(next);
}

function fromShellDto(shell: ActivityShellDto): ActivityShellState {
  return {
    shellId: shell.shell_id,
    lastEventAt: parseTime(shell.last_event_at) ?? 0,
    runningCount: Number(shell.running_call_count) || 0,
    activeUntil: shell.active ? parseTime(shell.active_until) : null,
  };
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
  return shell.runningCount > 0 || (shell.activeUntil != null && now < shell.activeUntil);
}

function retainRecentCalls(calls: ActivityCallView[], limit: number): ActivityCallView[] {
  const byId = new Map<string, ActivityCallView>();
  for (const call of calls) byId.set(call.call.id, call);

  const running: ActivityCallView[] = [];
  const completed: ActivityCallView[] = [];
  for (const call of byId.values()) {
    (call.call.status === "running" ? running : completed).push(call);
  }

  running.sort((a, b) => compareTime(b.call.started_at, a.call.started_at)
    || b.call.id.localeCompare(a.call.id));
  completed.sort((a, b) => compareTime(
    b.call.finished_at ?? b.call.started_at,
    a.call.finished_at ?? a.call.started_at,
  ) || b.call.id.localeCompare(a.call.id));

  return [...running, ...completed].slice(0, limit);
}

function projectShellCalls(workspaces: Iterable<ActivityWorkspaceState>): Map<number, ActivityCallView[]> {
  const byShell = new Map<number, ActivityCallView[]>();
  for (const workspace of workspaces) {
    for (const item of workspace.recentCalls) {
      const shellId = item.call.shell_id;
      if (shellId == null) continue;
      const calls = byShell.get(shellId) ?? [];
      calls.push(item);
      byShell.set(shellId, calls);
    }
  }
  for (const [shellId, calls] of byShell) {
    byShell.set(shellId, sortCallViews(calls));
  }
  return byShell;
}

export function mergeShellCallViews(
  history: ToolCallSummaryDto[],
  live: ActivityCallView[],
): ActivityCallView[] {
  const byId = new Map<string, ActivityCallView>();
  for (const call of history) byId.set(call.id, { call, updateRevision: 0 });
  for (const item of live) {
    const historical = byId.get(item.call.id);
    if (item.call.status === "running" || !historical) {
      byId.set(item.call.id, item);
    } else if (item.updateRevision > 0) {
      byId.set(item.call.id, {
        call: historical.call,
        updateRevision: item.updateRevision,
      });
    }
  }
  return sortCallViews([...byId.values()]);
}

function sortCallViews(calls: ActivityCallView[]): ActivityCallView[] {
  return [...calls].sort((a, b) => {
    const aRunning = a.call.status === "running";
    const bRunning = b.call.status === "running";
    if (aRunning !== bRunning) return aRunning ? -1 : 1;

    const aTime = aRunning ? a.call.started_at : (a.call.finished_at ?? a.call.started_at);
    const bTime = bRunning ? b.call.started_at : (b.call.finished_at ?? b.call.started_at);
    return compareTime(bTime, aTime) || b.call.id.localeCompare(a.call.id);
  });
}

function parseTime(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareTime(a: string, b: string): number {
  const aTime = Date.parse(a);
  const bTime = Date.parse(b);
  return (Number.isFinite(aTime) ? aTime : 0) - (Number.isFinite(bTime) ? bTime : 0);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
