import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { AppConfig } from "../config.js";
import { createOAuthRouter } from "../auth/routes.js";
import { OAuthService } from "../auth/oauth-service.js";
import { AuthStateStore } from "../auth/state-store.js";
import { createRequireBearer } from "../auth/middleware.js";
import { McpSessionManager } from "../mcp/session-manager.js";
import { createMcpRouter } from "../mcp/routes.js";
import { ActivityQuery } from "../observability/activity-query.js";
import { ActivityTracker } from "../observability/activity-tracker.js";
import { ToolCallRecorder } from "../observability/tool-call-recorder.js";
import { ToolLogStore } from "../observability/tool-log-store.js";
import { ShellStore } from "../shell-store.js";
import { SkillCatalog } from "../skills.js";
import {
  createActivityApiRouter,
} from "./activity-routes.js";
import { createRequireWebBasicAuth } from "./web-auth.js";
import {
  assertWebUiBuild,
  createWebUiRouter,
  defaultWebRoot,
  isCompiledServerRuntime,
} from "./web-ui-routes.js";

export type AppRuntime = {
  app: Express;
  close(): Promise<void>;
};

const MAX_ACTIVITY_HISTORY_CALLS = 10_000;

export type AppDependencies = {
  skills?: SkillCatalog;
  webRoot?: string;
};

export async function createApp(config: AppConfig, dependencies: AppDependencies = {}): Promise<AppRuntime> {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));

  const shells = await ShellStore.open(config.paths.configDir, config.paths.shellsDbFile);
  const skills = dependencies.skills ?? new SkillCatalog();
  const logs = new ToolLogStore(config.toolLogs.dir, config.toolLogs.maxCalls);
  const activityHistoryCalls = Math.min(config.toolLogs.maxCalls, MAX_ACTIVITY_HISTORY_CALLS);
  const activity = new ActivityTracker(activityHistoryCalls);
  try {
    await logs.initialize();
    activity.bootstrap(
      await logs.readRecent(activityHistoryCalls),
      (entry) => logs.isPayloadRetained(entry.file),
    );
  } catch (error) {
    console.error("Failed to initialize tool activity history:", error);
  }

  const recorder = new ToolCallRecorder(logs, activity);
  const query = new ActivityQuery(shells, logs, activity);
  const sessions = new McpSessionManager(shells, recorder, config.commandPath, skills);

  if (config.webPassword) {
    const webRoot = dependencies.webRoot ?? defaultWebRoot();
    if (process.env.NODE_ENV === "production" || isCompiledServerRuntime()) {
      await assertWebUiBuild(webRoot);
    }
    const requireWebAuth = createRequireWebBasicAuth(config.webPassword);

    app.get("/", (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.redirect(302, "/console/");
    });
    app.use("/api", webApiSecurityHeaders, requireWebAuth, createActivityApiRouter(query, activity));
    app.use("/console", webConsoleSecurityHeaders, requireWebAuth, createWebUiRouter(webRoot));
  }

  if (config.mode === "local") {
    app.use("/mcp", createMcpRouter(sessions));

    return {
      app,
      async close() {
        activity.close();
        await sessions.closeAll();
        shells.close();
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
      activity.close();
      await sessions.closeAll();
      await authState.persist();
      shells.close();
    },
  };
}

function webApiSecurityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
}

function webConsoleSecurityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join("; "),
  );
  next();
}
