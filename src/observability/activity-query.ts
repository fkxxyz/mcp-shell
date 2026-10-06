import type { ShellStore } from "../shell-store.js";
import type {
  ActivitySnapshotDto,
  ShellCallsDto,
  ToolCallDetailDto,
  ToolCallSummaryDto,
  WorkspaceShellsDto,
} from "../contracts/activity.js";
import type { ActivitySnapshot, ActivityTracker } from "./activity-tracker.js";
import type { ToolCallSummary } from "./tool-call.js";
import type { ToolHistoryCursor, ToolHistoryStore } from "./tool-history-store.js";

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
    private readonly logs: ToolHistoryStore,
    private readonly activity: ActivityTracker,
  ) {}

  snapshot(): ActivitySnapshotDto {
    return this.serializeSnapshot(this.activity.snapshot());
  }

  serializeSnapshot(snapshot: ActivitySnapshot): ActivitySnapshotDto {
    return {
      server_time: new Date(snapshot.serverTime).toISOString(),
      workspaces: snapshot.workspaces.map((workspace) => ({
        cwd: workspace.cwd,
        last_event_at: new Date(workspace.lastEventAt).toISOString(),
        running_call_count: workspace.runningCallCount,
        recent_calls: workspace.recentCalls.map(toApiSummary),
        recent_shells: workspace.recentShells.map((shell) => ({
          shell_id: shell.shellId,
          last_event_at: new Date(shell.lastEventAt).toISOString(),
          running_call_count: shell.runningCallCount,
        })),
      })),
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
        last_activity_at: this.latestShellEventAt(shell.id),
      })),
      next_cursor: shells.length === limit ? encodeCursor("shell", String(shells[shells.length - 1]!.id)) : null,
    };
  }

  listShellCalls(shellId: number, limit: number, before?: string): ShellCallsDto {
    const shell = this.shells.get(shellId);
    if (!shell) {
      throw new ActivityQueryError(404, "shell_not_found", `Unknown shell_id: ${shellId}`);
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
      throw new ActivityQueryError(409, "tool_call_running", "Tool call has not finished");
    }
    if (summary && summary.payloadAvailable === false) {
      throw new ActivityQueryError(410, "tool_call_payload_unavailable", "Tool call payload is no longer available");
    }

    const result = await this.logs.readCall(callId);
    if (result.kind === "payload_missing") {
      throw new ActivityQueryError(410, "tool_call_payload_unavailable", "Tool call payload is no longer available");
    }
    if (result.kind === "not_found") {
      throw new ActivityQueryError(
        summary ? 410 : 404,
        summary ? "tool_call_payload_unavailable" : "tool_call_not_found",
        summary ? "Tool call payload is no longer available" : "Unknown tool call",
      );
    }
    return result.record;
  }

  private latestShellEventAt(shellId: number): string | null {
    const call = this.logs.latestShellCall(shellId);
    return call?.finishedAt ? new Date(call.finishedAt).toISOString() : null;
  }
}

export function toApiSummary(call: ToolCallSummary): ToolCallSummaryDto {
  return {
    id: call.id,
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

function encodeCursor(kind: "shell" | "call", value: string): string {
  return `${kind}.${Buffer.from(value, "utf8").toString("base64url")}`;
}

function decodeCursor(cursor: string, kind: "shell" | "call"): string {
  const prefix = `${kind}.`;
  if (!cursor.startsWith(prefix)) {
    throw new ActivityQueryError(400, "invalid_cursor", "Cursor is invalid for this resource");
  }
  try {
    const value = Buffer.from(cursor.slice(prefix.length), "base64url").toString("utf8");
    if (!value) throw new Error("empty cursor");
    return value;
  } catch {
    throw new ActivityQueryError(400, "invalid_cursor", "Cursor is malformed");
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
    throw new ActivityQueryError(400, "invalid_cursor", "Cursor is malformed");
  }
}

function decodePositiveIntegerCursor(cursor: string, kind: "shell"): number {
  const value = Number(decodeCursor(cursor, kind));
  if (!Number.isInteger(value) || value <= 0) {
    throw new ActivityQueryError(400, "invalid_cursor", "Cursor is malformed");
  }
  return value;
}
