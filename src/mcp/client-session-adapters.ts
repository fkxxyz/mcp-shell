import type { Request } from "express";

/** Client-specific logical-session hints are observational, never security claims. */
export function resolveClientSessionHint(req: Pick<Request, "body" | "headers">): string | undefined {
  const openai = resolveOpenAISession(req);
  return openai ? `openai:${openai}` : undefined;
}

let reportedSessionConflict = false;

function resolveOpenAISession(req: Pick<Request, "body" | "headers">): string | undefined {
  const params = isRecord(req.body) && isRecord(req.body.params) ? req.body.params : undefined;
  const metadata = params && isRecord(params._meta) ? validSessionId(params._meta["openai/session"]) : undefined;
  const header = validSessionId(req.headers["x-openai-session"]);

  if (metadata && header && metadata !== header && !reportedSessionConflict) {
    reportedSessionConflict = true;
    // No raw identifiers: they are client-supplied and potentially sensitive.
    console.warn("OpenAI logical session hints disagree; preferring MCP params._meta");
  }

  return metadata ?? header;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validSessionId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return undefined;
  if (value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) return undefined;
  return value;
}
