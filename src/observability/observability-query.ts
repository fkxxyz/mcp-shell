import type { ShellStore } from "../shell-store.js";
import type {
  ActivityCallEventDto,
  ActivityShellDto,
  ActivitySnapshotDto,
  ActivityWorkspacePresenceDto,
  ShellActivityDto,
  ShellCallsDto,
  ToolCallDetailDto,
  ToolCallSummaryDto,
  WorkspaceShellsDto,
} from "../contracts/observability.js";
import {
  ACTIVITY_ACTIVE_WINDOW_MS,
  deriveActivityPresence,
} from "./activity-policy.js";
import type {
  ActivityEvent,
  ActivitySnapshot,
  ActivityTracker,
  ShellActivitySnapshot,
  WorkspaceSnapshot,
} from "./activity-tracker.js";
import type { ToolCallSummary } from "./tool-call.js";
import type { ToolHistoryCursor, ObservabilityStore } from "./observability-store.js";

export class ObservabilityQueryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class ObservabilityQuery {
  constructor(
    private readonly shells: ShellStore,
    private readonly logs: ObservabilityStore,
    private readonly activity: ActivityTracker,
  ) {}

  snapshot(): ActivitySnapshotDto {
    return this.serializeSnapshot(this.activity.snapshot());
  }

  serializeSnapshot(snapshot: ActivitySnapshot): ActivitySnapshotDto {
    const now = snapshot.serverTime;
    return {
      server_time: new Date(now).toISOString(),
      active_window_ms: ACTIVITY_ACTIVE_WINDOW_MS,
      workspaces: snapshot.workspaces.map((workspace) => ({
        ...serializeWorkspacePresence(workspace, now),
        recent_calls: workspace.recentCalls.map(toApiSummary),
        recent_shells: workspace.recentShells.map((shell) => serializeShellPresence(shell, now)),
      })),
    };
  }

  serializeCallEvent(event: ActivityEvent): ActivityCallEventDto {
    const now = event.serverTime;
    return {
      call: toApiSummary(event.call),
      server_time: new Date(now).toISOString(),
      workspace_activity: event.workspaceActivity
        ? serializeWorkspacePresence(event.workspaceActivity, now)
        : null,
      shell_activity: event.shellActivity
        ? serializeShellPresence(event.shellActivity, now)
        : null,
    };
  }

  getShellActivity(shellId: number): ShellActivityDto {
    const shell = this.shells.get(shellId);
    if (!shell) {
      throw new ObservabilityQueryError(404, "shell_not_found", `Unknown shell_id: ${shellId}`);
    }

    const now = Date.now();
    const activity = this.resolveShellActivity(shellId);
    const lastEventAt = activity?.lastEventAt ?? null;
    const runningCallCount = activity?.runningCallCount ?? 0;
    const presence = deriveActivityPresence(runningCallCount, lastEventAt, now);

    return {
      shell_id: shell.id,
      cwd: shell.cwd,
      created_at: new Date(shell.createdAt).toISOString(),
      last_event_at: toIsoOrNull(lastEventAt),
      running_call_count: runningCallCount,
      active: presence.active,
      active_until: toIsoOrNull(presence.activeUntil),
      server_time: new Date(now).toISOString(),
      active_window_ms: ACTIVITY_ACTIVE_WINDOW_MS,
    };
  }

  listWorkspaceShells(cwd: string, limit: number, before?: string): WorkspaceShellsDto {
    const beforeId = before ? decodePositiveIntegerCursor(before, "shell") : undefined;
    const shells = this.shells.listByCwd(cwd, limit, beforeId);
    return {
      cwd,
      items: shells.map((shell) => ({
        shell_id: shell.id,
        cwd: shell.cwd,
        created_at: new Date(shell.createdAt).toISOString(),
        last_activity_at: toIsoOrNull(this.resolveShellActivity(shell.id)?.lastEventAt ?? null),
      })),
      next_cursor: shells.length === limit ? encodeCursor("shell", String(shells[shells.length - 1]!.id)) : null,
    };
  }

  listShellCalls(shellId: number, limit: number, before?: string): ShellCallsDto {
    const shell = this.shells.get(shellId);
    if (!shell) {
      throw new ObservabilityQueryError(404, "shell_not_found", `Unknown shell_id: ${shellId}`);
    }

    const cursor = before ? decodeCallCursor(before, shellId) : undefined;
    const page = this.logs.listShellCalls(shellId, limit, cursor);
    return {
      shell: {
        shell_id: shell.id,
        cwd: shell.cwd,
        created_at: new Date(shell.createdAt).toISOString(),
      },
      items: page.items.map(toApiSummary),
      next_cursor: page.nextCursor ? encodeCallCursor(shellId, page.nextCursor) : null,
    };
  }

  async getToolCall(callId: string): Promise<ToolCallDetailDto> {
    const summary = this.activity.getCall(callId);
    if (summary?.status === "running") {
      throw new ObservabilityQueryError(409, "tool_call_running", "Tool call has not finished");
    }
    if (summary && summary.payloadAvailable === false) {
      throw new ObservabilityQueryError(410, "tool_call_payload_unavailable", "Tool call payload is no longer available");
    }

    const result = await this.logs.readCall(callId);
    if (result.kind === "payload_missing") {
      throw new ObservabilityQueryError(410, "tool_call_payload_unavailable", "Tool call payload is no longer available");
    }
    if (result.kind === "not_found") {
      throw new ObservabilityQueryError(
        summary ? 410 : 404,
        summary ? "tool_call_payload_unavailable" : "tool_call_not_found",
        summary ? "Tool call payload is no longer available" : "Unknown tool call",
      );
    }
    return {
      ...result.record,
      client_name: result.record.client_name ?? null,
      client_session_id: result.record.client_session_id ?? null,
    };
  }

  private resolveShellActivity(shellId: number): ShellActivitySnapshot | undefined {
    const runtime = this.activity.getShellActivity(shellId);
    if (runtime) return runtime;

    const persisted = this.logs.getShellActivity(shellId);
    if (!persisted) return undefined;

    return {
      shellId,
      cwd: persisted.cwd,
      lastEventAt: persisted.lastEventAt,
      runningCallCount: 0,
    };
  }
}

export function toApiSummary(call: ToolCallSummary): ToolCallSummaryDto {
  return {
    id: call.id,
    client_name: call.clientName ?? null,
    client_session_id: call.clientSessionId ?? null,
    shell_id: call.shellId ?? null,
    cwd: call.cwd ?? null,
    tool: call.tool,
    input_preview: call.inputPreview ?? null,
    started_at: new Date(call.startedAt).toISOString(),
    finished_at: call.finishedAt == null ? null : new Date(call.finishedAt).toISOString(),
    duration_ms: call.durationMs ?? null,
    status: call.status,
    payload_available: call.status === "running" ? false : Boolean(call.payloadAvailable),
  };
}

function serializeWorkspacePresence(
  workspace: Pick<WorkspaceSnapshot, "cwd" | "lastEventAt" | "runningCallCount">,
  now: number,
): ActivityWorkspacePresenceDto {
  const lastEventAt = Number.isFinite(workspace.lastEventAt) && workspace.lastEventAt > 0
    ? workspace.lastEventAt
    : null;
  const presence = deriveActivityPresence(workspace.runningCallCount, lastEventAt, now);
  return {
    cwd: workspace.cwd,
    last_event_at: toIsoOrNull(lastEventAt),
    running_call_count: workspace.runningCallCount,
    active: presence.active,
    active_until: toIsoOrNull(presence.activeUntil),
  };
}

function serializeShellPresence(
  shell: Pick<ShellActivitySnapshot, "shellId" | "lastEventAt" | "runningCallCount">,
  now: number,
): ActivityShellDto {
  const lastEventAt = Number.isFinite(shell.lastEventAt) && shell.lastEventAt > 0
    ? shell.lastEventAt
    : null;
  const presence = deriveActivityPresence(shell.runningCallCount, lastEventAt, now);
  return {
    shell_id: shell.shellId,
    last_event_at: toIsoOrNull(lastEventAt),
    running_call_count: shell.runningCallCount,
    active: presence.active,
    active_until: toIsoOrNull(presence.activeUntil),
  };
}

function toIsoOrNull(value: number | null): string | null {
  return value == null ? null : new Date(value).toISOString();
}

function encodeCursor(kind: "shell" | "call", value: string): string {
  return `${kind}.${Buffer.from(value, "utf8").toString("base64url")}`;
}

function decodeCursor(cursor: string, kind: "shell" | "call"): string {
  const prefix = `${kind}.`;
  if (!cursor.startsWith(prefix)) {
    throw new ObservabilityQueryError(400, "invalid_cursor", "Cursor is invalid for this resource");
  }
  try {
    const value = Buffer.from(cursor.slice(prefix.length), "base64url").toString("utf8");
    if (!value) throw new Error("empty cursor");
    return value;
  } catch {
    throw new ObservabilityQueryError(400, "invalid_cursor", "Cursor is malformed");
  }
}

function encodeCallCursor(shellId: number, cursor: ToolHistoryCursor): string {
  return `call.${Buffer.from(JSON.stringify([
    shellId,
    cursor.startedAt,
    cursor.sequence,
    cursor.id,
  ]), "utf8").toString("base64url")}`;
}

function decodeCallCursor(cursor: string, expectedShellId: number): ToolHistoryCursor {
  const encoded = decodeCursor(cursor, "call");
  try {
    const parsed = JSON.parse(encoded) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 4) throw new Error("invalid cursor tuple");
    const [shellId, startedAt, sequence, id] = parsed;
    if (
      shellId !== expectedShellId ||
      typeof startedAt !== "number" || !Number.isFinite(startedAt) ||
      typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 0 ||
      typeof id !== "string" || !id
    ) {
      throw new Error("invalid cursor values");
    }
    return { startedAt, sequence, id };
  } catch {
    throw new ObservabilityQueryError(400, "invalid_cursor", "Cursor is malformed");
  }
}

function decodePositiveIntegerCursor(cursor: string, kind: "shell"): number {
  const value = Number(decodeCursor(cursor, kind));
  if (!Number.isInteger(value) || value <= 0) {
    throw new ObservabilityQueryError(400, "invalid_cursor", "Cursor is malformed");
  }
  return value;
}
