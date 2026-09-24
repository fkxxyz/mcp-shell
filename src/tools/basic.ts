import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function registerPiTool(
	server: McpServer,
	name: string,
	description: string,
	inputSchema: Record<string, z.ZodType>,
	tool: { execute: (id: string, args: any, signal?: AbortSignal, onUpdate?: (result: any) => void, context?: any) => Promise<any> },
) {
	return server.registerTool(name, { description, inputSchema }, async (args, extra) => {
		const result = await tool.execute(`mcp-${name}`, args, extra.signal, undefined, {});
		return { content: result.content };
	});
}

export function registerBasicTools(server: McpServer, cwd: string) {
	const read = createReadTool(cwd);
	const write = createWriteTool(cwd);
	const edit = createEditTool(cwd);
	const bash = createBashTool(cwd, { exposeSessionEnvironment: false });

	registerPiTool(server, "read", read.description, {
		path: z.string().describe("Path to the file to read (relative or absolute)"),
		offset: z.number().optional().describe("Line number to start reading from (1-indexed)"),
		limit: z.number().optional().describe("Maximum number of lines to read"),
	}, read);
	registerPiTool(server, "write", write.description, {
		path: z.string().describe("Path to the file to write (relative or absolute)"),
		content: z.string().describe("Content to write to the file"),
	}, write);
	registerPiTool(server, "edit", edit.description, {
		path: z.string().describe("Path to the file to edit (relative or absolute)"),
		edits: z.array(z.object({
			oldText: z.string().describe("Exact text to replace"),
			newText: z.string().describe("Replacement text"),
		})).min(1).describe("Targeted, unique, non-overlapping replacements"),
	}, edit);
	registerPiTool(server, "bash", bash.description, {
		command: z.string().describe("Bash command to execute"),
		timeout: z.number().positive().optional().describe("Timeout in seconds; no timeout by default"),
	}, bash);
}
