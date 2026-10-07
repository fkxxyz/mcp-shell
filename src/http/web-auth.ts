import type { NextFunction, Request, Response } from "express";
import { createReadBasicAuthorizationValidator } from "../auth/read-basic-credentials.js";

export function createRequireWebBasicAuth(password: string) {
  const isValidAuthorization = createReadBasicAuthorizationValidator(password);

  return function requireWebBasicAuth(req: Request, res: Response, next: NextFunction) {
    if (!isValidAuthorization(req.header("authorization"))) {
      res.setHeader("WWW-Authenticate", 'Basic realm="mcp-shell web", charset="UTF-8"');
      return res.status(401).type("text").send("Authentication required");
    }
    next();
  };
}
