import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CommandPathPolicy } from "../command-path.js";
import type { FileMutationCoordinator } from "../host/file-mutation-coordinator.js";
import type { ProcessSupervisor } from "../host/process-supervisor.js";
import type { ToolCallRecorder } from "../observability/tool-call-recorder.js";
import type { ShellStore } from "../shell-store.js";
import { invokeShellTool } from "./invoke.js";
import type { InvocationGate } from "./invocation-gate.js";
import { runBash } from "./basic/bash.js";
import { editTextFile } from "./basic/edit.js";
import { readTextFile } from "./basic/read.js";
import { writeTextFile } from "./basic/write.js";
import { shellIdSchema } from "./shell.js";

const contentBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});
const detailsSchema = z.record(z.string(), z.unknown()).nullable();
const basicOutputSchema = {
  content: z.array(contentBlockSchema),
  details: detailsSchema,
};

export function registerBasicTools(
  server: McpServer,
  invocations: InvocationGate,
  shells: ShellStore,
  recorder: ToolCallRecorder,
  commandPath: CommandPathPolicy,
  mutations: FileMutationCoordinator,
  processes: ProcessSupervisor,
) {
  server.registerTool("read", {
    description:
      "Read the contents of a text file. Images are not supported; use read_image for image files. Output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
    inputSchema: {
      shell_id: shellIdSchema,
      path: z.string().describe("Path to the file to read (relative to the shell root or absolute)"),
      offset: z.number().int().positive().optional().describe("Line number to start reading from (1-indexed)"),
      limit: z.number().int().positive().optional().describe("Maximum number of lines to read"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: basicOutputSchema,
  }, async (input, extra) => invokeShellTool(invocations, recorder, shells, "read", input, async (shell) => {
    const result = await readTextFile(shell.cwd, input, extra.signal);
    return {
      content: result.content,
      structuredContent: result,
    };
  }));

  server.registerTool("write", {
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    inputSchema: {
      shell_id: shellIdSchema,
      path: z.string().describe("Path to the file to write (relative to the shell root or absolute)"),
      content: z.string().describe("Content to write to the file"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: basicOutputSchema,
  }, async (input, extra) => invokeShellTool(invocations, recorder, shells, "write", input, async (shell) => {
    const result = await writeTextFile(shell.cwd, input, mutations, extra.signal);
    return {
      content: result.content,
      structuredContent: result,
    };
  }));

  server.registerTool("edit", {
    description:
      "Edit a single file using exact text replacement. Every edits[].oldText must match one unique, non-overlapping region of the original file after line-ending normalization. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits.",
    inputSchema: {
      shell_id: shellIdSchema,
      path: z.string().describe("Path to the file to edit (relative to the shell root or absolute)"),
      edits: z.array(z.object({
        oldText: z.string().describe("Exact text to replace"),
        newText: z.string().describe("Replacement text"),
      })).min(1).describe("Targeted, unique, non-overlapping replacements"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    outputSchema: basicOutputSchema,
  }, async (input, extra) => invokeShellTool(invocations, recorder, shells, "edit", input, async (shell) => {
    const result = await editTextFile(shell.cwd, input, mutations, extra.signal);
    return {
      content: result.content,
      structuredContent: result,
    };
  }));

  server.registerTool("bash", {
    description:
      "Execute a bash command in the Shell working directory. Returns combined stdout and stderr in observed arrival order. Output is truncated to the last 2000 lines or 50KB (whichever is hit first). Redirect output to a file when complete large output is required.",
    inputSchema: {
      shell_id: shellIdSchema,
      command: z.string().describe("Bash command to execute"),
      timeout: z.number().finite().positive().max(2_147_483.647).optional()
        .describe("Timeout in seconds; no timeout by default"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    outputSchema: basicOutputSchema,
  }, async (input, extra) => invokeShellTool(invocations, recorder, shells, "bash", input, async (shell) => {
    const result = await runBash(shell.cwd, input, commandPath, processes, extra.signal);
    return {
      content: result.content,
      structuredContent: result,
    };
  }, { shutdownCancellable: true }));
}
