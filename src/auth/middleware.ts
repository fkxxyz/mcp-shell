import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "../config.js";
import { toolLogActorFromToken } from "../tool-logs.js";
import { OAuthService } from "./oauth-service.js";

export function createRequireBearer(config: AppConfig, oauth: OAuthService) {
  return function requireBearer(req: Request, res: Response, next: NextFunction) {
    const match = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "");
    const token = match?.[1];

    if (!token || !oauth.validateAccessToken(token)) {
      res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${config.publicBaseUrl}/.well-known/oauth-protected-resource", scope="full"`);
      return res.status(401).json({ error: "unauthorized" });
    }

    res.locals.toolLogActor = toolLogActorFromToken(token);
    next();
  };
}
