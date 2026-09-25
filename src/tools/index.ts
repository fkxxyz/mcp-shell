import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CommandPathPolicy } from "../command-path.js";
import { registerBasicTools } from "./basic.js";
import { registerApplyPatchTool } from "./apply-patch.js";
import { registerLspTools } from "./lsp.js";
import { registerReadImageTool } from "./read-image.js";

export function registerTools(server: McpServer, cwd: string, commandPath: CommandPathPolicy) {
	registerBasicTools(server, cwd, commandPath);
	registerApplyPatchTool(server, cwd);
	registerLspTools(server, cwd, commandPath);
	registerReadImageTool(server, cwd, commandPath);
}
