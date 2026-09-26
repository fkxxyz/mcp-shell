import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createShell } from "../shell.js";
import type { ShellStore } from "../shell-store.js";
import { recordToolCall } from "../tool-logs.js";

export const shellIdSchema = z.number().int().positive().describe("Shell ID returned by create_shell");

export function registerShellTool(server: McpServer, shells: ShellStore) {
  return server.registerTool("create_shell", {
    title: "Create Shell",
    description: "Reuse an existing valid shell rooted at the required directory when available; otherwise create a persistent shell there.",
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
  }, async (input) => recordToolCall("create_shell", input, async () => {
    const result = await createShell(shells, input.cwd);
    const structuredContent = {
      shell_id: result.shellId,
      instructions: result.instructions,
    };
    return {
      content: [{ type: "text", text: result.instructions }],
      structuredContent,
    };
  }));
}
