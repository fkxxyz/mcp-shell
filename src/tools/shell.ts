import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { ToolCallRecorder } from "../observability/tool-call-recorder.js";
import { createShell } from "../shell.js";
import type { ShellStore } from "../shell-store.js";

export const shellIdSchema = z.number().int().positive().describe("Shell ID returned by create_shell");

export function registerShellTool(server: McpServer, shells: ShellStore, recorder: ToolCallRecorder) {
  return server.registerTool("create_shell", {
    title: "Create Shell",
    description: "Create a persistent shell rooted at the given directory. Reuse an existing shell when its cwd matches the required working directory; create a new shell only when the working directory changes. Returns the shell ID and instructions for using it.",
    inputSchema: {
      cwd: z.string().describe("Absolute directory path for the shell root"),
    },
    outputSchema: {
      shell_id: z.number().int().positive(),
      instructions: z.string(),
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
      const result = await createShell(shells, input.cwd);
      const structuredContent = {
        shell_id: result.shellId,
        instructions: result.instructions,
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
