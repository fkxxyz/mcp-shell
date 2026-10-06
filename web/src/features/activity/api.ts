import type {
  ActivityCallEventDto,
  ActivitySnapshotDto,
  ShellCallsDto,
  ToolCallDetailDto,
  ToolCallSummaryDto,
  WorkspaceShellsDto,
} from "../../../../src/contracts/activity";
import { requestJson } from "../../lib/api-client";

const API_ROOT = "/api";

export const activityQueryKeys = {
  workspaceShells: (cwd: string) => ["workspace-shells", cwd] as const,
  shellCalls: (shellId: number) => ["shell-calls", shellId] as const,
  toolCall: (callId: string) => ["tool-call", callId] as const,
};

export function openActivityStream(handlers: {
  onOpen(): void;
  onError(): void;
  onSnapshot(snapshot: ActivitySnapshotDto): void;
  onCall(call: ToolCallSummaryDto): void;
}): () => void {
  const source = new EventSource(`${API_ROOT}/activity/stream`);

  source.addEventListener("open", handlers.onOpen);
  source.addEventListener("error", handlers.onError);
  source.addEventListener("snapshot", (event) => {
    handlers.onSnapshot(JSON.parse(event.data) as ActivitySnapshotDto);
  });
  const onCall = (event: MessageEvent<string>) => {
    handlers.onCall((JSON.parse(event.data) as ActivityCallEventDto).call);
  };
  source.addEventListener("tool_call.started", onCall);
  source.addEventListener("tool_call.finished", onCall);

  return () => source.close();
}

export function listWorkspaceShells(cwd: string, before?: string | null): Promise<WorkspaceShellsDto> {
  const url = new URL(`${API_ROOT}/shells`, location.origin);
  url.searchParams.set("cwd", cwd);
  url.searchParams.set("limit", "50");
  if (before) url.searchParams.set("before", before);
  return requestJson(url);
}

export function listShellCalls(shellId: number, before?: string | null): Promise<ShellCallsDto> {
  const url = new URL(`${API_ROOT}/shells/${encodeURIComponent(shellId)}/calls`, location.origin);
  url.searchParams.set("limit", "50");
  if (before) url.searchParams.set("before", before);
  return requestJson(url);
}

export function getToolCall(callId: string): Promise<ToolCallDetailDto> {
  return requestJson(`${API_ROOT}/tool-calls/${encodeURIComponent(callId)}`);
}
