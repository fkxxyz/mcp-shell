import express, { type Express } from "express";
import type { AppConfig } from "../config.js";
import { createOAuthRouter } from "../auth/routes.js";
import { OAuthService } from "../auth/oauth-service.js";
import { AuthStateStore } from "../auth/state-store.js";
import { createRequireBearer } from "../auth/middleware.js";
import { McpSessionManager } from "../mcp/session-manager.js";
import { createMcpRouter } from "../mcp/routes.js";

export type AppRuntime = {
  app: Express;
  close(): Promise<void>;
};

export async function createApp(config: AppConfig): Promise<AppRuntime> {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));

  const sessions = new McpSessionManager(config.workdir, config.commandPath);

  if (config.mode === "local") {
    app.use("/mcp", createMcpRouter(sessions));

    return {
      app,
      async close() {
        await sessions.closeAll();
      },
    };
  }

  const authState = new AuthStateStore(config.paths.configDir, config.paths.stateFile);
  await authState.load();
  const oauth = new OAuthService(config, authState);

  app.use(createOAuthRouter(config, oauth));
  app.use("/mcp", createRequireBearer(config, oauth), createMcpRouter(sessions));

  const cleanupTimer = setInterval(() => {
    if (authState.cleanupExpired()) authState.persistSoon();
  }, 60_000);
  cleanupTimer.unref();

  return {
    app,
    async close() {
      clearInterval(cleanupTimer);
      await sessions.closeAll();
      await authState.persist();
    },
  };
}
