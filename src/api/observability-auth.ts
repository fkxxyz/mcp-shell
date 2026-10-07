import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { createReadBasicAuthorizationValidator } from "../auth/read-basic-credentials.js";

export type ObservabilityAuthConfig = {
  observabilityToken?: string;
  webPassword?: string;
};

export function createRequireObservabilityAuth(config: ObservabilityAuthConfig) {
  const expectedBearer = config.observabilityToken ? digest(config.observabilityToken) : undefined;
  const isValidWebBasic = config.webPassword
    ? createReadBasicAuthorizationValidator(config.webPassword)
    : undefined;

  return function requireObservabilityAuth(req: Request, res: Response, next: NextFunction) {
    const authorization = req.header("authorization");
    if (
      (expectedBearer && isValidBearerAuthorization(authorization, expectedBearer)) ||
      (isValidWebBasic && isValidWebBasic(authorization))
    ) {
      next();
      return;
    }

    const challenges: string[] = [];
    if (expectedBearer) challenges.push('Bearer realm="mcp-shell observability"');
    if (config.webPassword) challenges.push('Basic realm="mcp-shell web", charset="UTF-8"');
    if (challenges.length > 0) res.setHeader("WWW-Authenticate", challenges);
    res.status(401).json({
      error: {
        code: "unauthorized",
        message: "Authentication required",
      },
    });
  };
}

function isValidBearerAuthorization(value: string | undefined, expected: Buffer): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(value ?? "");
  if (!match) return false;
  return timingSafeEqual(digest(match[1]!), expected);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
