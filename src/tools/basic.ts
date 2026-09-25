import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { extname } from "node:path";
import { z } from "zod";
import { recordToolCall } from "../tool-logs.js";

const contentBlockSchema = z.union([
	z.object({ type: z.literal("text"), text: z.string() }),
	z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
]);

const detailsSchema = z.record(z.string(), z.unknown()).nullable();

function registerPiTool(
	server: McpServer,
	name: string,
	description: string,
	inputSchema: Record<string, z.ZodType>,
	annotations: {
		readOnlyHint: boolean;
		destructiveHint: boolean;
		idempotentHint: boolean;
		openWorldHint: boolean;
	},
	tool: { execute: (id: string, args: any, signal?: AbortSignal, onUpdate?: (result: any) => void, context?: any) => Promise<any> },
) {
	return server.registerTool(name, {
		description,
		inputSchema,
		annotations,
		outputSchema: {
			content: z.array(contentBlockSchema),
			details: detailsSchema,
		},
	}, async (args, extra) => recordToolCall(name, args, async () => {
		const result = await tool.execute(`mcp-${name}`, args, extra.signal, undefined, {});
		return {
			content: result.content,
			structuredContent: {
				content: result.content,
				details: result.details ?? null,
			},
		};
	}));
}

export function registerBasicTools(server: McpServer, cwd: string) {
	const read = createReadTool(cwd);
	const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
	const textRead = {
		...read,
		description:
			"Read the contents of a text file. Images are not supported; use read_image for image files. Output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
		async execute(id: string, args: any, signal?: AbortSignal, onUpdate?: (result: any) => void, context?: any) {
			if (imageExtensions.has(extname(args.path).toLowerCase())) {
				throw new Error("read only supports text files. Use read_image for image files.");
			}

			const result = await read.execute(id, args, signal, onUpdate);
			if (result.content?.some((item: { type?: string }) => item.type === "image")) {
				throw new Error("read only supports text files. Use read_image for image files.");
			}
			return result;
		},
	};
	const write = createWriteTool(cwd);
	const edit = createEditTool(cwd);
	const bash = createBashTool(cwd, { exposeSessionEnvironment: false });

	registerPiTool(server, "read", textRead.description, {
		path: z.string().describe("Path to the file to read (relative or absolute)"),
		offset: z.number().optional().describe("Line number to start reading from (1-indexed)"),
		limit: z.number().optional().describe("Maximum number of lines to read"),
	}, {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	}, textRead);
	registerPiTool(server, "write", write.description, {
		path: z.string().describe("Path to the file to write (relative or absolute)"),
		content: z.string().describe("Content to write to the file"),
	}, {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: false,
	}, write);
	registerPiTool(server, "edit", edit.description, {
		path: z.string().describe("Path to the file to edit (relative or absolute)"),
		edits: z.array(z.object({
			oldText: z.string().describe("Exact text to replace"),
			newText: z.string().describe("Replacement text"),
		})).min(1).describe("Targeted, unique, non-overlapping replacements"),
	}, {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: false,
	}, edit);
	registerPiTool(server, "bash", bash.description, {
		command: z.string().describe("Bash command to execute"),
		timeout: z.number().positive().optional().describe("Timeout in seconds; no timeout by default"),
	}, {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true,
	}, bash);
}
