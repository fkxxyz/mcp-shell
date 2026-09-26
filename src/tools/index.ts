import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CommandPathPolicy } from "../command-path.js";
import type { ShellStore } from "../shell-store.js";
import { registerBasicTools } from "./basic.js";
import { registerApplyPatchTool } from "./apply-patch.js";
import { registerLspTools } from "./lsp.js";
import { registerReadImageTool } from "./read-image.js";
import { registerShellTool } from "./shell.js";

export function registerTools(server: McpServer, shells: ShellStore, commandPath: CommandPathPolicy) {
	registerShellTool(server, shells);
	registerBasicTools(server, shells, commandPath);
	registerApplyPatchTool(server, shells);
	registerLspTools(server, shells, commandPath);
	registerReadImageTool(server, shells, commandPath);
}
