import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CommandPathPolicy } from "../command-path.js";
import type { FileMutationCoordinator } from "../host/file-mutation-coordinator.js";
import type { ProcessSupervisor } from "../host/process-supervisor.js";
import type { ToolCallRecorder } from "../observability/tool-call-recorder.js";
import type { ShellStore } from "../shell-store.js";
import type { SkillCatalog } from "../skills.js";
import { registerBasicTools } from "./basic.js";
import { registerApplyPatchTool } from "./apply-patch.js";
import { registerLspTools, type LSPServerManager } from "./lsp.js";
import { registerReadImageTool } from "./read-image.js";
import { registerSkillTool } from "./skill.js";
import { registerShellTool } from "./shell.js";
import type { InvocationGate } from "./invocation-gate.js";

export function registerTools(
  server: McpServer,
  invocations: InvocationGate,
  shells: ShellStore,
  recorder: ToolCallRecorder,
  commandPath: CommandPathPolicy,
  skills: SkillCatalog,
  mutations: FileMutationCoordinator,
  processes: ProcessSupervisor,
  lspManager: LSPServerManager,
) {
	registerShellTool(server, invocations, shells, recorder, skills);
	registerSkillTool(server, invocations, recorder, skills);
	registerBasicTools(server, invocations, shells, recorder, commandPath, mutations, processes);
	registerApplyPatchTool(server, invocations, shells, recorder, mutations);
	registerLspTools(server, invocations, shells, recorder, commandPath, mutations, lspManager);
	registerReadImageTool(server, invocations, shells, recorder, commandPath, processes);
}
