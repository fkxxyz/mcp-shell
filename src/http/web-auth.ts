import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

// Kept stable for existing browser credential stores. WEB_PASSWORD defines
// the broader authority boundary; the fixed username carries no privilege.
export const WEB_BASIC_USERNAME = "activity";

export function createRequireWebBasicAuth(password: string) {
  const expectedPassword = digest(password);

  return function requireWebBasicAuth(req: Request, res: Response, next: NextFunction) {
    const credentials = parseBasicAuthorization(req.header("authorization"));
    if (
      !credentials ||
      credentials.username !== WEB_BASIC_USERNAME ||
      !timingSafeEqual(digest(credentials.password), expectedPassword)
    ) {
      res.setHeader("WWW-Authenticate", 'Basic realm="mcp-shell web", charset="UTF-8"');
      return res.status(401).type("text").send("Authentication required");
    }
    next();
  };
}

function parseBasicAuthorization(value: string | undefined): { username: string; password: string } | undefined {
  const match = /^Basic\s+(.+)$/i.exec(value ?? "");
  if (!match) return undefined;

  try {
    const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon < 0) return undefined;
    return {
      username: decoded.slice(0, colon),
      password: decoded.slice(colon + 1),
    };
  } catch {
    return undefined;
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
