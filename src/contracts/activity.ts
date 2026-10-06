export type ToolCallStatusDto = "running" | "success" | "error";

export type ToolCallSummaryDto = {
  id: string;
  shell_id: number | null;
  cwd: string | null;
  tool: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  status: ToolCallStatusDto;
  payload_available: boolean;
};

export type ActivityWorkspaceDto = {
  cwd: string;
  last_event_at: string;
  running_call_count: number;
  recent_calls: ToolCallSummaryDto[];
};

export type ActivitySnapshotDto = {
  server_time: string;
  workspaces: ActivityWorkspaceDto[];
};

export type ActivityCallEventDto = {
  call: ToolCallSummaryDto;
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
