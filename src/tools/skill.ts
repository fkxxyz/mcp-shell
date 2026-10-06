import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolCallRecorder } from "../observability/tool-call-recorder.js";
import type { SkillCatalog } from "../skills.js";

export function registerSkillTool(server: McpServer, recorder: ToolCallRecorder, skills: SkillCatalog) {
  return server.registerTool("skill", {
    title: "Load Skill",
    description: "Load the current instructions for an available skill by its exact name.",
    inputSchema: {
      name: z.string().describe("Exact skill name listed by create_shell"),
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
  }, async (input) => recorder.run({ tool: "skill", input }, async () => {
    const skill = await skills.load(input.name);
    if (!skill) throw new Error(`Skill not found: ${input.name}`);

    return {
      content: [{
        type: "text",
        text: `Skill: ${skill.name}\nSkill directory: ${skill.directory}\n\n${skill.instructions}`,
      }],
      structuredContent: skill,
    };
  }));
}
