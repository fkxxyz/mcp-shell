import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { ToolCallRecorder } from "../observability/tool-call-recorder.js";
import { createShell } from "../shell.js";
import type { ShellStore } from "../shell-store.js";
import type { SkillCatalog } from "../skills.js";

export const shellIdSchema = z.number().int().positive().describe("Shell ID returned by create_shell");

export function registerShellTool(
  server: McpServer,
  shells: ShellStore,
  recorder: ToolCallRecorder,
  skills: SkillCatalog,
) {
  return server.registerTool("create_shell", {
    title: "Create Shell",
    description: "Create a new persistent shell rooted at the given directory. Keep using an existing shell ID from this agent session while its working directory remains suitable; call create_shell again when a different working directory is required. Returns the new shell ID, bootstrap instructions, and available skill summaries.",
    inputSchema: {
      cwd: z.string().describe("Absolute directory path for the shell root"),
    },
    outputSchema: {
      shell_id: z.number().int().positive(),
      instructions: z.string(),
      skills: z.array(z.object({
        name: z.string(),
        description: z.string(),
      })),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async (input) => {
    const activityCwd = isAbsolute(input.cwd) ? resolve(input.cwd) : undefined;
    return recorder.run({ tool: "create_shell", input, cwd: activityCwd }, async () => {
      const result = await createShell(shells, input.cwd, { skillCatalog: skills });
      const structuredContent = {
        shell_id: result.shellId,
        instructions: result.instructions,
        skills: result.skills,
      };
      return {
        content: [{ type: "text", text: result.instructions }],
        structuredContent,
      };
    }, (output) => ({
      shellId: output.structuredContent.shell_id,
      cwd: activityCwd,
    }));
  });
}
