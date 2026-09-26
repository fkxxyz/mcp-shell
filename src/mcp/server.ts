import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CommandPathPolicy } from "../command-path.js";
import type { ShellStore } from "../shell-store.js";
import { registerTools } from "../tools/index.js";

export function createMcpServer(shells: ShellStore, commandPath: CommandPathPolicy): McpServer {
  const server = new McpServer({ name: "mcp-shell", version: "0.1.0" });
  registerTools(server, shells, commandPath);
  return server;
}
