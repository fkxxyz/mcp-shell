import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { extname } from "node:path";
import { z } from "zod";
import { applyCommandPath, type CommandPathPolicy } from "../command-path.js";
import type { ShellStore } from "../shell-store.js";
import { recordToolCall } from "../tool-logs.js";
import { shellIdSchema } from "./shell.js";

const contentBlockSchema = z.union([
	z.object({ type: z.literal("text"), text: z.string() }),
	z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
]);

const detailsSchema = z.record(z.string(), z.unknown()).nullable();

function registerPiTool(
	server: McpServer,
	shells: ShellStore,
	name: string,
	description: string,
	inputSchema: Record<string, z.ZodType>,
	annotations: {
		readOnlyHint: boolean;
		destructiveHint: boolean;
		idempotentHint: boolean;
		openWorldHint: boolean;
	},
	toolFactory: (cwd: string) => { execute: (id: string, args: any, signal?: AbortSignal, onUpdate?: (result: any) => void, context?: any) => Promise<any> },
) {
	return server.registerTool(name, {
		description,
		inputSchema: { shell_id: shellIdSchema, ...inputSchema },
		annotations,
		outputSchema: {
			content: z.array(contentBlockSchema),
			details: detailsSchema,
		},
	}, async (args, extra) => recordToolCall(name, args, async () => {
		const cwd = shells.require(args.shell_id).cwd;
		const { shell_id: _shellId, ...toolArgs } = args;
		const result = await toolFactory(cwd).execute(`mcp-${name}`, toolArgs, extra.signal, undefined, {});
		return {
			content: result.content,
			structuredContent: {
				content: result.content,
				details: result.details ?? null,
			},
		};
	}));
}

export function registerBasicTools(server: McpServer, shells: ShellStore, commandPath: CommandPathPolicy) {
	const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
	const textReadDescription =
		"Read the contents of a text file. Images are not supported; use read_image for image files. Output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.";
	const createTextRead = (cwd: string) => {
		const read = createReadTool(cwd);
		return {
			...read,
			description: textReadDescription,
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
	};
	const createBash = (cwd: string) => createBashTool(cwd, {
		exposeSessionEnvironment: false,
		spawnHook(context) {
			return {
				...context,
				env: applyCommandPath(context.env, commandPath),
			};
		},
	});

	registerPiTool(server, shells, "read", textReadDescription, {
		path: z.string().describe("Path to the file to read (relative to the shell root or absolute)"),
		offset: z.number().optional().describe("Line number to start reading from (1-indexed)"),
		limit: z.number().optional().describe("Maximum number of lines to read"),
	}, {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	}, createTextRead);
	registerPiTool(server, shells, "write", createWriteTool("/").description, {
		path: z.string().describe("Path to the file to write (relative to the shell root or absolute)"),
		content: z.string().describe("Content to write to the file"),
	}, {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: false,
	}, createWriteTool);
	registerPiTool(server, shells, "edit", createEditTool("/").description, {
		path: z.string().describe("Path to the file to edit (relative to the shell root or absolute)"),
		edits: z.array(z.object({
			oldText: z.string().describe("Exact text to replace"),
			newText: z.string().describe("Replacement text"),
		})).min(1).describe("Targeted, unique, non-overlapping replacements"),
	}, {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: false,
	}, createEditTool);
	registerPiTool(server, shells, "bash", createBash("/").description, {
		command: z.string().describe("Bash command to execute"),
		timeout: z.number().positive().optional().describe("Timeout in seconds; no timeout by default"),
	}, {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true,
	}, createBash);
}
