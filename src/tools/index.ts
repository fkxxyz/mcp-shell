import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerBasicTools } from "./basic.js";
import { registerApplyPatchTool } from "./apply-patch.js";
import { registerLspTools } from "./lsp.js";
import { registerReadImageTool } from "./read-image.js";

export function registerTools(server: McpServer, cwd: string) {
	registerBasicTools(server, cwd);
	registerApplyPatchTool(server, cwd);
	registerLspTools(server, cwd);
	registerReadImageTool(server, cwd);
}
