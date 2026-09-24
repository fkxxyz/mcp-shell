import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../tools/index.js";

export function createMcpServer(cwd: string): McpServer {
  const server = new McpServer({ name: "computer-demo", version: "0.1.0" });
  registerTools(server, cwd);
  return server;
}
