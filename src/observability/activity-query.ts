import type { ShellStore } from "../shell-store.js";
import type { ActivitySnapshot, ActivityTracker } from "./activity-tracker.js";
import type { ToolCallSummary } from "./tool-call.js";
import type { ToolLogStore } from "./tool-log-store.js";

export class ActivityQueryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class ActivityQuery {
  constructor(
    private readonly shells: ShellStore,
    private readonly logs: ToolLogStore,
    private readonly activity: ActivityTracker,
  ) {}

  snapshot() {
    return this.serializeSnapshot(this.activity.snapshot());
  }

  serializeSnapshot(snapshot: ActivitySnapshot) {
    return {
      server_time: new Date(snapshot.serverTime).toISOString(),
      workspaces: snapshot.workspaces.map((workspace) => ({
        cwd: workspace.cwd,
        last_event_at: new Date(workspace.lastEventAt).toISOString(),
        running_call_count: workspace.runningCallCount,
        recent_calls: workspace.recentCalls.map(toApiSummary),
      })),
    };
  }

  listWorkspaceShells(cwd: string, limit: number, beforeId?: number) {
    const shells = this.shells.listByCwd(cwd, limit, beforeId);
    return {
      cwd,
      items: shells.map((shell) => ({
        shell_id: shell.id,
        cwd: shell.cwd,
        created_at: new Date(shell.createdAt).toISOString(),
        last_activity_at: this.latestShellEventAt(shell.id),
      })),
      next_cursor: shells.length === limit ? String(shells[shells.length - 1]!.id) : null,
    };
  }

  listShellCalls(shellId: number, limit: number, beforeId?: string) {
    const shell = this.shells.get(shellId);
    if (!shell) {
      throw new ActivityQueryError(404, "shell_not_found", `Unknown shell_id: ${shellId}`);
    }

    if (beforeId) {
      const cursor = this.activity.getCall(beforeId);
      if (!cursor || cursor.shellId !== shellId) {
        throw new ActivityQueryError(400, "invalid_cursor", "Call cursor does not belong to this shell");
      }
    }

    const calls = this.activity.listShellCalls(shellId, limit, beforeId);
    return {
      shell: {
        shell_id: shell.id,
        cwd: shell.cwd,
        created_at: new Date(shell.createdAt).toISOString(),
      },
      items: calls.map(toApiSummary),
      next_cursor: calls.length === limit ? calls[calls.length - 1]!.id : null,
    };
  }

  async getToolCall(callId: string) {
    const summary = this.activity.getCall(callId);
    if (!summary) {
      throw new ActivityQueryError(404, "tool_call_not_found", "Unknown tool call");
    }
    if (summary.status === "running") {
      throw new ActivityQueryError(409, "tool_call_running", "Tool call has not finished");
    }
    if (!summary.payloadAvailable || !summary.payloadFile) {
      throw new ActivityQueryError(410, "tool_call_payload_unavailable", "Tool call payload is no longer available");
    }

    const record = await this.logs.readPayload(summary.payloadFile);
    if (!record) {
      throw new ActivityQueryError(410, "tool_call_payload_unavailable", "Tool call payload is no longer available");
    }
    return record;
  }

  private latestShellEventAt(shellId: number): string | null {
    const calls = this.activity.listShellCalls(shellId, 1);
    return calls[0]?.finishedAt ? new Date(calls[0].finishedAt).toISOString() : null;
  }
}

export function toApiSummary(call: ToolCallSummary) {
  return {
    id: call.id,
    shell_id: call.shellId ?? null,
    cwd: call.cwd ?? null,
    tool: call.tool,
    started_at: new Date(call.startedAt).toISOString(),
    finished_at: call.finishedAt == null ? null : new Date(call.finishedAt).toISOString(),
    duration_ms: call.durationMs ?? null,
    status: call.status,
    payload_available: call.status === "running" ? false : Boolean(call.payloadAvailable),
  };
}
