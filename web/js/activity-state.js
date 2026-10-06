const ACTIVE_WINDOW_MS = 10 * 60 * 1000;
const MAX_RECENT_CALLS = 10;

export class ActivityState {
  constructor(onChange) {
    this.onChange = onChange;
    this.workspaces = new Map();
    this.activeOrder = [];
    this.earlierOrder = [];
    this.clockOffset = 0;
  }

  replaceSnapshot(snapshot) {
    const serverTime = Date.parse(snapshot.server_time);
    this.clockOffset = Number.isFinite(serverTime) ? serverTime - Date.now() : 0;

    this.workspaces.clear();
    this.activeOrder = [];
    this.earlierOrder = [];

    for (const item of snapshot.workspaces ?? []) {
      const workspace = {
        cwd: item.cwd,
        lastEventAt: Date.parse(item.last_event_at),
        runningCount: Number(item.running_call_count) || 0,
        recentCalls: [...(item.recent_calls ?? [])],
      };
      this.workspaces.set(workspace.cwd, workspace);
      if (this.isActive(workspace)) this.activeOrder.push(workspace.cwd);
      else this.earlierOrder.push(workspace.cwd);
    }

    this.emit();
  }

  applyCall(call) {
    if (!call?.cwd) return;

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

  expire() {
    const expired = this.activeOrder
      .map((cwd) => this.workspaces.get(cwd))
      .filter((workspace) => workspace && !this.isActive(workspace));

    if (expired.length === 0) return false;

    const expiredIds = new Set(expired.map((workspace) => workspace.cwd));
    this.activeOrder = this.activeOrder.filter((cwd) => !expiredIds.has(cwd));
    expired.sort((a, b) => b.lastEventAt - a.lastEventAt);
    this.earlierOrder = [
      ...expired.map((workspace) => workspace.cwd),
      ...this.earlierOrder.filter((cwd) => !expiredIds.has(cwd)),
    ];
    this.emit();
    return true;
  }

  view() {
    return {
      now: this.now(),
      active: this.activeOrder.map((cwd) => this.workspaces.get(cwd)).filter(Boolean),
      earlier: this.earlierOrder.map((cwd) => this.workspaces.get(cwd)).filter(Boolean),
    };
  }

  now() {
    return Date.now() + this.clockOffset;
  }

  isActive(workspace) {
    return workspace.runningCount > 0 || this.now() - workspace.lastEventAt < ACTIVE_WINDOW_MS;
  }

  removeFromOrders(cwd) {
    this.activeOrder = this.activeOrder.filter((item) => item !== cwd);
    this.earlierOrder = this.earlierOrder.filter((item) => item !== cwd);
  }

  emit() {
    this.onChange?.(this.view());
  }
}
