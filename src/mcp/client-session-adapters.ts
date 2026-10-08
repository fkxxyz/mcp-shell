import type { Request } from "express";

/** Client-specific logical-session hints are observational, never security claims. */
export function resolveClientSessionHint(req: Pick<Request, "body" | "headers">): string | undefined {
  const openai = resolveOpenAISession(req);
  return openai ? `openai:${openai}` : undefined;
}

function resolveOpenAISession(req: Pick<Request, "body" | "headers">): string | undefined {
  // The live probe cannot establish equality between x-openai-session and
  // params._meta["openai/session"]: the temporary diagnostic hashed raw header
  // strings but JSON-stringified metadata values. An unverified fallback could
  // split a logical session. Only the header is currently a canonical source.
  return validSessionId(req.headers["x-openai-session"]);
}

function validSessionId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return undefined;
  if (value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) return undefined;
  return value;
}
