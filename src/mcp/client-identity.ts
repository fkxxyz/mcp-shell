import type { Request } from "express";
import { resolveClientSessionHint } from "./client-session-adapters.js";

export type ClientIdentity = {
  clientName?: string;
  clientSessionId?: string;
};

/**
 * Resolve optional, *observational* client identity. Never use these values for
 * authentication or authorization: both clientInfo and vendor hints are client supplied.
 */
export function resolveClientIdentity(
  clientName: string | undefined,
  req: Pick<Request, "body" | "headers">,
): ClientIdentity {
  const name = validIdentity(clientName, 128);
  return {
    clientName: name,
    // A batch can contain different logical sessions. Do not attribute one
    // request's header to every tool in the batch.
    clientSessionId: Array.isArray(req.body) ? undefined : resolveClientSessionHint(req),
  };
}

function validIdentity(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return undefined;
  if (value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) return undefined;
  return value;
}
