export type ToolCallStatusDto = "running" | "success" | "error";

export type ToolCallSummaryDto = {
  id: string;
  client_name: string | null;
  client_session_id: string | null;
  shell_id: number | null;
  cwd: string | null;
  tool: string;
  input_preview: Record<string, unknown> | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  status: ToolCallStatusDto;
  payload_available: boolean;
};

export type ActivityShellDto = {
  shell_id: number;
  last_event_at: string | null;
  running_call_count: number;
  active: boolean;
  active_until: string | null;
};

export type ActivityWorkspacePresenceDto = {
  cwd: string;
  last_event_at: string | null;
  running_call_count: number;
  active: boolean;
  active_until: string | null;
};

export type ActivityWorkspaceDto = ActivityWorkspacePresenceDto & {
  recent_calls: ToolCallSummaryDto[];
  recent_shells: ActivityShellDto[];
};

export type ActivitySnapshotDto = {
  server_time: string;
  active_window_ms: number;
  workspaces: ActivityWorkspaceDto[];
};

export type ActivityCallEventDto = {
  call: ToolCallSummaryDto;
  server_time: string;
  workspace_activity: ActivityWorkspacePresenceDto | null;
  shell_activity: ActivityShellDto | null;
};

export type ShellActivityDto = ActivityShellDto & {
  cwd: string;
  created_at: string;
  server_time: string;
  active_window_ms: number;
};

export type ShellSummaryDto = {
  shell_id: number;
  cwd: string;
  created_at: string;
  last_activity_at: string | null;
};

export type WorkspaceShellsDto = {
  cwd: string;
  items: ShellSummaryDto[];
  next_cursor: string | null;
};

export type ShellCallsDto = {
  shell: {
    shell_id: number;
    cwd: string;
    created_at: string;
  };
  items: ToolCallSummaryDto[];
  next_cursor: string | null;
};

export type ToolCallDetailDto = {
  version: 2;
  id: string;
  sequence: number;
  shell_id?: number;
  cwd?: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  session?: string;
  actor?: string;
  client_name: string | null;
  client_session_id: string | null;
  tool: string;
  input: unknown;
  status: "success" | "error";
  output?: unknown;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
};

export type ApiErrorDto = {
  error: {
    code: string;
    message: string;
  };
};
