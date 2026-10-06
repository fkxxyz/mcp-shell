import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CommandPathPolicy } from "../command-path.js";
import type { ToolCallRecorder } from "../observability/tool-call-recorder.js";
import type { ShellStore } from "../shell-store.js";
import { registerTools } from "../tools/index.js";

export function createMcpServer(shells: ShellStore, recorder: ToolCallRecorder, commandPath: CommandPathPolicy): McpServer {
  const server = new McpServer({ name: "mcp-shell", version: "0.1.0" });
  registerTools(server, shells, recorder, commandPath);
  return server;
}
