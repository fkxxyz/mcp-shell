import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CommandPathPolicy } from "../command-path.js";
import type { FileMutationCoordinator } from "../host/file-mutation-coordinator.js";
import type { ProcessSupervisor } from "../host/process-supervisor.js";
import type { ToolCallRecorder } from "../observability/tool-call-recorder.js";
import type { ShellStore } from "../shell-store.js";
import type { SkillCatalog } from "../skills.js";
import type { InvocationGate } from "../tools/invocation-gate.js";
import { registerTools } from "../tools/index.js";

export function createMcpServer(
  invocations: InvocationGate,
  shells: ShellStore,
  recorder: ToolCallRecorder,
  commandPath: CommandPathPolicy,
  skills: SkillCatalog,
  mutations: FileMutationCoordinator,
  processes: ProcessSupervisor,
): McpServer {
  const server = new McpServer({ name: "mcp-shell", version: "0.1.0" });
  registerTools(server, invocations, shells, recorder, commandPath, skills, mutations, processes);
  return server;
}
