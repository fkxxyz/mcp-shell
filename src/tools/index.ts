import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CommandPathPolicy } from "../command-path.js";
import type { FileMutationCoordinator } from "../host/file-mutation-coordinator.js";
import type { ProcessSupervisor } from "../host/process-supervisor.js";
import type { ToolCallRecorder } from "../observability/tool-call-recorder.js";
import type { ShellStore } from "../shell-store.js";
import type { SkillCatalog } from "../skills.js";
import { registerBasicTools } from "./basic.js";
import { registerApplyPatchTool } from "./apply-patch.js";
import { registerLspTools } from "./lsp.js";
import { registerReadImageTool } from "./read-image.js";
import { registerSkillTool } from "./skill.js";
import { registerShellTool } from "./shell.js";

export function registerTools(
  server: McpServer,
  shells: ShellStore,
  recorder: ToolCallRecorder,
  commandPath: CommandPathPolicy,
  skills: SkillCatalog,
  mutations: FileMutationCoordinator,
  processes: ProcessSupervisor,
) {
	registerShellTool(server, shells, recorder, skills);
	registerSkillTool(server, recorder, skills);
	registerBasicTools(server, shells, recorder, commandPath, mutations, processes);
	registerApplyPatchTool(server, shells, recorder, mutations);
	registerLspTools(server, shells, recorder, commandPath, mutations);
	registerReadImageTool(server, shells, recorder, commandPath, processes);
}
