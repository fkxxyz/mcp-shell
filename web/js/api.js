const API_ROOT = "/activity/api/v1";

export function openActivityStream(handlers) {
  const source = new EventSource(`${API_ROOT}/stream`);

  source.addEventListener("open", () => handlers.onOpen?.());
  source.addEventListener("error", () => handlers.onError?.());

  source.addEventListener("snapshot", (event) => {
    handlers.onSnapshot?.(parseEvent(event));
  });
  source.addEventListener("tool_call.started", (event) => {
    handlers.onCall?.(parseEvent(event).call);
  });
  source.addEventListener("tool_call.finished", (event) => {
    handlers.onCall?.(parseEvent(event).call);
  });

  return () => source.close();
}

export async function listWorkspaceShells(cwd, before) {
  const url = new URL(`${API_ROOT}/shells`, location.origin);
  url.searchParams.set("cwd", cwd);
  url.searchParams.set("limit", "50");
  if (before) url.searchParams.set("before", before);
  return requestJson(url);
}

export async function listShellCalls(shellId, before) {
  const url = new URL(`${API_ROOT}/shells/${encodeURIComponent(shellId)}/calls`, location.origin);
  url.searchParams.set("limit", "50");
  if (before) url.searchParams.set("before", before);
  return requestJson(url);
}

export async function getToolCall(callId) {
  return requestJson(new URL(`${API_ROOT}/tool-calls/${encodeURIComponent(callId)}`, location.origin));
}

async function requestJson(url) {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error?.message || `Request failed: ${response.status}`);
    error.code = body?.error?.code;
    error.status = response.status;
    throw error;
  }
  return body;
}

function parseEvent(event) {
  return JSON.parse(event.data);
}
