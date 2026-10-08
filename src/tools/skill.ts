import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolCallRecorder } from "../observability/tool-call-recorder.js";
import type { ShellStore } from "../shell-store.js";
import type { SkillCatalog } from "../skills.js";
import type { InvocationGate } from "./invocation-gate.js";

export function registerSkillTool(
  server: McpServer,
  invocations: InvocationGate,
  recorder: ToolCallRecorder,
  shells: ShellStore,
  skills: SkillCatalog,
) {
  return server.registerTool("skill", {
    title: "Load Skill",
    description: "Load a skill by exact name. Pass shell_id from create_shell to include project-local skills and overrides; omit it to load global skills only.",
    inputSchema: {
      name: z.string().describe("Exact skill name listed by create_shell"),
      shell_id: z.number().int().positive().optional().describe("Shell ID from create_shell; required for project-local skills"),
    },
    outputSchema: {
      name: z.string(),
      description: z.string(),
      directory: z.string(),
      instructions: z.string(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async (input) => invocations.run(() => recorder.run({ tool: "skill", input }, async () => {
    const projectCwd = input.shell_id === undefined ? undefined : shells.require(input.shell_id).cwd;
    const skill = await skills.load(input.name, projectCwd);
    if (!skill) throw new Error(`Skill not found: ${input.name}`);

    return {
      content: [{
        type: "text",
        text: `Skill: ${skill.name}\nSkill directory: ${skill.directory}\n\n${skill.instructions}`,
      }],
      structuredContent: skill,
    };
  })));
}
