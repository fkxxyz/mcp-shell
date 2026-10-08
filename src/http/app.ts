import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { createRequireObservabilityAuth } from "../api/observability-auth.js";
import { createObservabilityApiRouter } from "../api/v1/router.js";
import type { AppConfig } from "../config.js";
import { createOAuthRouter } from "../auth/routes.js";
import { OAuthService } from "../auth/oauth-service.js";
import { AuthStateStore } from "../auth/state-store.js";
import { createRequireBearer } from "../auth/middleware.js";
import { FileMutationCoordinator } from "../host/file-mutation-coordinator.js";
import { ProcessSupervisor } from "../host/process-supervisor.js";
import { McpSessionManager } from "../mcp/session-manager.js";
import { createMcpRouter } from "../mcp/routes.js";
import { ACTIVITY_ACTIVE_WINDOW_MS } from "../observability/activity-policy.js";
import { ObservabilityQuery } from "../observability/observability-query.js";
import { ActivityTracker } from "../observability/activity-tracker.js";
import { ActivityService } from "../observability/activity-service.js";
import { ToolCallRecorder } from "../observability/tool-call-recorder.js";
import { ObservabilityStore } from "../observability/observability-store.js";
import { ShellStore } from "../shell-store.js";
import { SkillCatalog } from "../skills.js";
import { DrainGate } from "../runtime/drain-gate.js";
import { InvocationGate } from "../tools/invocation-gate.js";
import { LSPServerManager } from "../tools/lsp.js";
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
const TOOL_SHUTDOWN_GRACE_MS = 3_000;

export type AppDependencies = {
  skills?: SkillCatalog;
  lspManager?: LSPServerManager;
  webRoot?: string;
};

export async function createApp(config: AppConfig, dependencies: AppDependencies = {}): Promise<AppRuntime> {
  const app = express();
  const requests = new DrainGate();
  const invocations = new InvocationGate();

  app.disable("x-powered-by");
  app.use(createRequestAdmission(requests));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));

  const shells = await ShellStore.open(config.paths.configDir, config.paths.shellsDbFile);
  const skills = dependencies.skills ?? new SkillCatalog();
  const logs = new ObservabilityStore(config.toolLogs.dir, config.toolLogs.maxCalls);
  const activityHistoryCalls = Math.min(config.toolLogs.maxCalls, MAX_ACTIVITY_HISTORY_CALLS);
  const activity = new ActivityTracker(activityHistoryCalls);
  try {
    await logs.initialize();
    activity.bootstrap(logs.readRecent(activityHistoryCalls));
  } catch (error) {
    console.error("Failed to initialize tool activity history:", error);
  }
  try {
    await logs.initializeActivity();
    activity.bootstrapShellActivity(
      logs.listShellActivitySince(Date.now() - ACTIVITY_ACTIVE_WINDOW_MS).map((shell) => ({
        ...shell,
        runningCallCount: 0,
      })),
    );
  } catch (error) {
    console.error("Failed to initialize Shell activity state:", error);
  }

  const presence = new ActivityService(logs);
  const recorder = new ToolCallRecorder(logs, activity, presence);
  const query = new ObservabilityQuery(shells, logs, activity, presence);
  const mutations = new FileMutationCoordinator();
  const processes = new ProcessSupervisor();
  const lspManager = dependencies.lspManager ?? new LSPServerManager();
  const sessions = new McpSessionManager(
    invocations,
    shells,
    recorder,
    config.commandPath,
    skills,
    mutations,
    processes,
    lspManager,
  );

  if (config.mode === "local") {
    app.use("/api/v1", observabilityApiSecurityHeaders, createObservabilityApiRouter(query, activity));
  } else if (config.webPassword || config.observabilityToken) {
    app.use(
      "/api/v1",
      observabilityApiSecurityHeaders,
      createRequireObservabilityAuth(config),
      createObservabilityApiRouter(query, activity),
    );
  }

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
    app.use("/console", webConsoleSecurityHeaders, requireWebAuth, createWebUiRouter(webRoot));
  }

  let authState: AuthStateStore | undefined;
  let cleanupTimer: NodeJS.Timeout | undefined;

  if (config.mode === "local") {
    app.use("/mcp", createMcpRouter(sessions));
  } else {
    authState = new AuthStateStore(config.paths.configDir, config.paths.stateFile);
    await authState.load();
    const oauth = new OAuthService(config, authState);

    app.use(createOAuthRouter(config, oauth));
    app.use("/mcp", createRequireBearer(config, oauth), createMcpRouter(sessions));

    cleanupTimer = setInterval(() => {
      if (authState?.cleanupExpired()) authState.persistSoon();
    }, 60_000);
    cleanupTimer.unref();
  }

  let closePromise: Promise<void> | undefined;
  const finishClose = async () => {
    const activeInvocations = invocations.activeCount;
    if (activeInvocations > 0) {
      console.log(
        `Shutdown draining ${activeInvocations} active tool invocation(s) for up to ${TOOL_SHUTDOWN_GRACE_MS}ms`,
      );
    }

    const drainedWithinGrace = activeInvocations === 0 || await settlesWithin(
      invocations.drained(),
      TOOL_SHUTDOWN_GRACE_MS,
    );
    if (!drainedWithinGrace) {
      const interrupted = invocations.interruptCancellable();
      console.warn(
        `Shutdown tool grace period expired with ${invocations.activeCount} invocation(s) still active; ` +
        `interrupting ${interrupted} cancellable invocation(s) and terminating managed processes`,
      );
    }

    await Promise.all([
      processes.close(),
      lspManager.close(),
    ]);
    await invocations.drained();
    await requests.drained();
    await sessions.close();
    if (authState) await authState.persist();
    logs.close();
    shells.close();
  };

  return {
    app,
    close() {
      requests.close();
      invocations.close();
      sessions.stopAccepting();
      activity.close();
      sessions.closeStandaloneStreams();
      if (cleanupTimer) clearInterval(cleanupTimer);
      closePromise ??= finishClose();
      return closePromise;
    },
  };
}

function createRequestAdmission(gate: DrainGate) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const lease = gate.enter();
    if (!lease) {
      res.setHeader("Connection", "close");
      res.status(503).json({
        error: {
          code: "server_shutting_down",
          message: "Server is shutting down",
        },
      });
      return;
    }

    res.once("finish", lease.release);
    res.once("close", lease.release);
    next();
  };
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    void promise.then(() => finish(true));
  });
}

function observabilityApiSecurityHeaders(_req: Request, res: Response, next: NextFunction): void {
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
