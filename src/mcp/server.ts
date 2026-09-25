import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CommandPathPolicy } from "../command-path.js";
import { registerTools } from "../tools/index.js";

export function createMcpServer(cwd: string, commandPath: CommandPathPolicy): McpServer {
  const server = new McpServer({ name: "mcp-shell", version: "0.1.0" });
  registerTools(server, cwd, commandPath);
  return server;
}
