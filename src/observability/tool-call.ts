export type ToolLogContext = {
  session?: string;
  actor?: string;
};

export type ToolCallIdentity = {
  id: string;
  tool: string;
  shellId?: number;
  cwd?: string;
  inputPreview?: Record<string, unknown>;
};

export type RunningToolCall = ToolCallIdentity & {
  startedAt: number;
};

export type ToolCallStatus = "success" | "error";

export type FinishedToolCallSummary = ToolCallIdentity & {
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  status: ToolCallStatus;
  payloadAvailable: boolean;
  payloadFile?: string;
};

export type ToolCallSummary = RunningToolCall & {
  finishedAt?: number;
  durationMs?: number;
  status: "running" | ToolCallStatus;
  payloadAvailable?: boolean;
  payloadFile?: string;
};

export type SerializedToolError = {
  name: string;
  message: string;
  stack?: string;
};

export type ToolCallRecord = {
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
  status: ToolCallStatus;
  output?: unknown;
  error?: SerializedToolError;
};

export type ToolCallIndexEntry = {
  version?: number;
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
  status: ToolCallStatus;
  stored_bytes: number;
  file: string;
};

export function serializeToolError(error: unknown): SerializedToolError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    name: "Error",
    message: String(error),
  };
}

export function summaryFromIndex(entry: ToolCallIndexEntry, payloadAvailable = true): FinishedToolCallSummary {
  return {
    id: entry.id,
    tool: entry.tool,
    shellId: entry.shell_id,
    cwd: entry.cwd,
    startedAt: Date.parse(entry.started_at),
    finishedAt: Date.parse(entry.finished_at),
    durationMs: entry.duration_ms,
    status: entry.status,
    payloadAvailable,
    payloadFile: payloadAvailable ? entry.file : undefined,
  };
}
