import { Router } from "express";
import { withToolLogContext } from "../tool-logs.js";
import { McpSessionManager } from "./session-manager.js";

export function createMcpRouter(sessions: McpSessionManager): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    try {
      const transport = await sessions.resolveForPost(req.header("mcp-session-id"), req.body);
      if (!transport) {
        return res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: invalid or missing MCP session" },
          id: null,
        });
      }

      await withToolLogContext({
        session: req.header("mcp-session-id"),
        actor: res.locals.toolLogActor,
      }, () => transport.handleRequest(req, res, req.body));
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  router.get("/", async (req, res) => {
    const transport = sessions.get(req.header("mcp-session-id"));
    if (!transport) {
      return res.status(400).type("text").send("Invalid or missing MCP session");
    }
    await withToolLogContext({
      session: req.header("mcp-session-id"),
      actor: res.locals.toolLogActor,
    }, () => transport.handleRequest(req, res));
  });

  router.delete("/", async (req, res) => {
    const transport = sessions.get(req.header("mcp-session-id"));
    if (!transport) {
      return res.status(400).type("text").send("Invalid or missing MCP session");
    }
    await withToolLogContext({
      session: req.header("mcp-session-id"),
      actor: res.locals.toolLogActor,
    }, () => transport.handleRequest(req, res));
  });

  return router;
}
