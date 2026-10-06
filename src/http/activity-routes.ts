import { once } from "node:events";
import { Router, type Response } from "express";
import type { ActivityTracker } from "../observability/activity-tracker.js";
import {
  ActivityQuery,
  ActivityQueryError,
  toApiSummary,
} from "../observability/activity-query.js";

export function createActivityApiRouter(query: ActivityQuery, activity: ActivityTracker): Router {
  const router = Router();

  router.get("/activity/stream", (req, res) => {
    const opened = activity.openFeed();
    let closed = false;
    let heartbeat: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      opened.feed.close();
      if (heartbeat) clearInterval(heartbeat);
    };

    req.on("close", cleanup);
    res.on("close", cleanup);

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    void (async () => {
      try {
        await writeEvent(res, "snapshot", query.serializeSnapshot(opened.snapshot));

        while (!closed) {
          const event = await opened.feed.next();
          if (!event) break;
          await writeEvent(res, event.type, { call: toApiSummary(event.call) });
        }
      } catch (error) {
        if (!closed) console.error("Activity SSE stream failed:", error);
      } finally {
        cleanup();
        if (!res.writableEnded) res.end();
      }
    })();

    heartbeat = setInterval(() => {
      if (!closed && !res.writableEnded) res.write(": heartbeat\n\n");
    }, 25_000);
    heartbeat.unref();
  });

  router.get("/shells", (req, res) => {
    try {
      const cwd = typeof req.query.cwd === "string" ? req.query.cwd : "";
      if (!cwd) return sendError(res, 400, "invalid_request", "cwd is required");

      const limit = parseLimit(req.query.limit, 20, 100);
      const before = typeof req.query.before === "string" && req.query.before ? req.query.before : undefined;

      return res.json(query.listWorkspaceShells(cwd, limit, before));
    } catch (error) {
      return handleQueryError(res, error);
    }
  });

  router.get("/shells/:shellId/calls", (req, res) => {
    try {
      const shellId = parsePositiveInteger(req.params.shellId);
      if (shellId === undefined) {
        return sendError(res, 400, "invalid_request", "shellId must be a positive integer");
      }

      const limit = parseLimit(req.query.limit, 50, 100);
      const before = typeof req.query.before === "string" && req.query.before ? req.query.before : undefined;
      return res.json(query.listShellCalls(shellId, limit, before));
    } catch (error) {
      return handleQueryError(res, error);
    }
  });

  router.get("/tool-calls/:callId", async (req, res) => {
    try {
      return res.json(await query.getToolCall(req.params.callId));
    } catch (error) {
      return handleQueryError(res, error);
    }
  });

  return router;
}

function parseLimit(value: unknown, fallback: number, max: number): number {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function handleQueryError(res: Response, error: unknown) {
  if (error instanceof ActivityQueryError) {
    return sendError(res, error.status, error.code, error.message);
  }
  console.error("Activity API failed:", error);
  return sendError(res, 500, "internal_error", "Internal server error");
}

function sendError(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ error: { code, message } });
}

async function writeEvent(res: Response, event: string, data: unknown): Promise<void> {
  const writable = res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (writable) return;
  await Promise.race([
    once(res, "drain"),
    once(res, "close"),
  ]);
}
