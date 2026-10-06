import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CommandPathPolicy } from "../command-path.js";
import type { ToolCallRecorder } from "../observability/tool-call-recorder.js";
import type { ShellStore } from "../shell-store.js";
import { registerBasicTools } from "./basic.js";
import { registerApplyPatchTool } from "./apply-patch.js";
import { registerLspTools } from "./lsp.js";
import { registerReadImageTool } from "./read-image.js";
import { registerShellTool } from "./shell.js";

export function registerTools(server: McpServer, shells: ShellStore, recorder: ToolCallRecorder, commandPath: CommandPathPolicy) {
	registerShellTool(server, shells, recorder);
	registerBasicTools(server, shells, recorder, commandPath);
	registerApplyPatchTool(server, shells, recorder);
	registerLspTools(server, shells, recorder, commandPath);
	registerReadImageTool(server, shells, recorder, commandPath);
}
