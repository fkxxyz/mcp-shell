import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createTwoFilesPatch, diffLines } from "diff";
import { z } from "zod";
import type { FileMutationCoordinator } from "../host/file-mutation-coordinator.js";
import type { ToolCallRecorder } from "../observability/tool-call-recorder.js";
import type { ShellStore } from "../shell-store.js";
import { invokeShellTool } from "./invoke.js";
import { shellIdSchema } from "./shell.js";

const DESCRIPTION = `Use the \`apply_patch\` tool to edit files. Your patch language is a stripped‑down, file‑oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high‑level envelope:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Within that envelope, you get a sequence of file operations.
You MUST include a header to specify the action you are taking.
Each operation starts with one of three headers:

*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).
*** Delete File: <path> - remove an existing file. Nothing follows.
*** Update File: <path> - patch an existing file in place (optionally with a rename).

Example patch:

\`\`\`
*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch
\`\`\`

It is important to remember:

- You must include a header with your intended action (Add/Delete/Update)
- You must prefix new lines with \`+\` even when creating a file
- Patch paths may be relative to the shell root or absolute. Relative paths are resolved against the shell root and may include \`..\`.`;

type Hunk =
	| { type: "add"; path: string; contents: string }
	| { type: "delete"; path: string }
	| { type: "update"; path: string; move_path?: string; chunks: UpdateFileChunk[] };

type UpdateFileChunk = {
	old_lines: string[];
	new_lines: string[];
	change_context?: string;
	is_end_of_file?: boolean;
};

type FileChange = {
	filePath: string;
	oldContent: string;
	newContent: string;
	type: "add" | "update" | "delete" | "move";
	movePath?: string;
	diff: string;
	additions: number;
	deletions: number;
	bom: boolean;
};

type TextFile = { text: string; bom: boolean; newline: "\n" | "\r\n" };

type PlannedState = {
	filePath: string;
	text: string;
	bom: boolean;
	newline: "\n" | "\r\n";
	exists: boolean;
};

function isFileSectionHeader(line: string): boolean {
	return line.startsWith("*** Add File:") || line.startsWith("*** Delete File:") || line.startsWith("*** Update File:");
}

function parsePatchHeader(
	lines: string[],
	startIdx: number,
): { filePath: string; movePath?: string; nextIdx: number } | null {
	const line = lines[startIdx];

	if (line.startsWith("*** Add File:")) {
		const filePath = line.slice("*** Add File:".length).trim();
		return filePath ? { filePath, nextIdx: startIdx + 1 } : null;
	}

	if (line.startsWith("*** Delete File:")) {
		const filePath = line.slice("*** Delete File:".length).trim();
		return filePath ? { filePath, nextIdx: startIdx + 1 } : null;
	}

	if (line.startsWith("*** Update File:")) {
		const filePath = line.slice("*** Update File:".length).trim();
		let movePath: string | undefined;
		let nextIdx = startIdx + 1;

		if (nextIdx < lines.length && lines[nextIdx].startsWith("*** Move to:")) {
			movePath = lines[nextIdx].slice("*** Move to:".length).trim();
			nextIdx++;
		}

		return filePath ? { filePath, movePath, nextIdx } : null;
	}

	return null;
}

function parseUpdateFileChunks(lines: string[], startIdx: number): { chunks: UpdateFileChunk[]; nextIdx: number } {
	const chunks: UpdateFileChunk[] = [];
	let i = startIdx;

	while (i < lines.length && !isFileSectionHeader(lines[i]) && lines[i].trim() !== "*** End Patch") {
		if (lines[i].startsWith("@@")) {
			const contextLine = lines[i].substring(2).trim();
			i++;

			const oldLines: string[] = [];
			const newLines: string[] = [];
			let isEndOfFile = false;

			while (i < lines.length && !lines[i].startsWith("@@") && !isFileSectionHeader(lines[i]) && lines[i].trim() !== "*** End Patch") {
				const changeLine = lines[i];

				if (changeLine === "*** End of File") {
					isEndOfFile = true;
					i++;
					break;
				}

				if (changeLine.startsWith(" ")) {
					const content = changeLine.substring(1);
					oldLines.push(content);
					newLines.push(content);
				} else if (changeLine.startsWith("-")) {
					oldLines.push(changeLine.substring(1));
				} else if (changeLine.startsWith("+")) {
					newLines.push(changeLine.substring(1));
				} else {
					throw new Error(`Invalid update line: ${changeLine}`);
				}

				i++;
			}

			chunks.push({
				old_lines: oldLines,
				new_lines: newLines,
				change_context: contextLine || undefined,
				is_end_of_file: isEndOfFile || undefined,
			});
		} else if (lines[i].trim() === "") {
			i++;
		} else {
			throw new Error(`Invalid update section line: ${lines[i]}`);
		}
	}

	return { chunks, nextIdx: i };
}

function parseAddFileContent(lines: string[], startIdx: number): { content: string; nextIdx: number } {
	let content = "";
	let i = startIdx;

	while (i < lines.length && !isFileSectionHeader(lines[i]) && lines[i].trim() !== "*** End Patch") {
		if (lines[i].startsWith("+")) {
			content += lines[i].substring(1) + "\n";
		} else {
			throw new Error(`Invalid add file line: ${lines[i]}`);
		}
		i++;
	}

	if (content.endsWith("\n")) {
		content = content.slice(0, -1);
	}

	return { content, nextIdx: i };
}

function stripHeredoc(input: string): string {
	const heredocMatch = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
	if (heredocMatch) return heredocMatch[2];
	return input;
}

function parsePatch(patchText: string): { hunks: Hunk[] } {
	const cleaned = stripHeredoc(patchText.trim());
	const lines = cleaned.split("\n");
	const hunks: Hunk[] = [];

	const beginMarker = "*** Begin Patch";
	const endMarker = "*** End Patch";

	const beginIdx = lines.findIndex((line) => line.trim() === beginMarker);
	const endIdx = lines.findIndex((line) => line.trim() === endMarker);

	if (beginIdx === -1 || endIdx === -1 || beginIdx >= endIdx) {
		throw new Error("Invalid patch format: missing Begin/End markers");
	}

	let i = beginIdx + 1;
	while (i < endIdx) {
		const header = parsePatchHeader(lines, i);
		if (!header) {
			i++;
			continue;
		}

		if (lines[i].startsWith("*** Add File:")) {
			const { content, nextIdx } = parseAddFileContent(lines, header.nextIdx);
			hunks.push({ type: "add", path: header.filePath, contents: content });
			i = nextIdx;
		} else if (lines[i].startsWith("*** Delete File:")) {
			hunks.push({ type: "delete", path: header.filePath });
			i = header.nextIdx;
		} else if (lines[i].startsWith("*** Update File:")) {
			const { chunks, nextIdx } = parseUpdateFileChunks(lines, header.nextIdx);
			hunks.push({ type: "update", path: header.filePath, move_path: header.movePath, chunks });
			i = nextIdx;
		} else {
			i++;
		}
	}

	return { hunks };
}

function splitBom(content: string): { text: string; bom: boolean } {
	if (content.startsWith("\uFEFF")) return { text: content.slice(1), bom: true };
	return { text: content, bom: false };
}

function joinBom(content: string, bom: boolean): string {
	return bom ? `\uFEFF${content}` : content;
}

async function readTextFile(filePath: string): Promise<TextFile> {
	const content = await readFile(filePath, "utf8");
	const { text, bom } = splitBom(content);
	return { text, bom, newline: text.includes("\r\n") ? "\r\n" : "\n" };
}

function normalizeNewlines(content: string): string {
	return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function applyNewlineStyle(content: string, newline: "\n" | "\r\n"): string {
	return newline === "\r\n" ? content.replace(/\n/g, "\r\n") : content;
}

function normalizeUnicode(str: string): string {
	return str
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-")
		.replace(/\u2026/g, "...")
		.replace(/\u00A0/g, " ");
}

type Comparator = (a: string, b: string) => boolean;

function findMatches(lines: string[], pattern: string[], startIndex: number, compare: Comparator, eof: boolean): number[] {
	const matches: number[] = [];

	if (eof) {
		const fromEnd = lines.length - pattern.length;
		if (fromEnd >= startIndex) {
			let matched = true;
			for (let j = 0; j < pattern.length; j++) {
				if (!compare(lines[fromEnd + j], pattern[j])) {
					matched = false;
					break;
				}
			}
			if (matched) matches.push(fromEnd);
		}

		return matches;
	}

	for (let i = startIndex; i <= lines.length - pattern.length; i++) {
		let matched = true;
		for (let j = 0; j < pattern.length; j++) {
			if (!compare(lines[i + j], pattern[j])) {
				matched = false;
				break;
			}
		}
		if (matched) matches.push(i);
	}

	return matches;
}

function firstUniqueMatch(matches: number[]): number {
	if (matches.length === 0) return -1;
	if (matches.length > 1) return -2;
	return matches[0];
}

function seekSequence(lines: string[], pattern: string[], startIndex: number, eof = false): number {
	if (pattern.length === 0) return -1;

	const exact = firstUniqueMatch(findMatches(lines, pattern, startIndex, (a, b) => a === b, eof));
	if (exact !== -1) return exact;

	const rstrip = firstUniqueMatch(findMatches(lines, pattern, startIndex, (a, b) => a.trimEnd() === b.trimEnd(), eof));
	if (rstrip !== -1) return rstrip;

	const trim = firstUniqueMatch(findMatches(lines, pattern, startIndex, (a, b) => a.trim() === b.trim(), eof));
	if (trim !== -1) return trim;

	return firstUniqueMatch(findMatches(lines, pattern, startIndex, (a, b) => normalizeUnicode(a.trim()) === normalizeUnicode(b.trim()), eof));
}

function computeReplacements(
	originalLines: string[],
	filePath: string,
	chunks: UpdateFileChunk[],
): Array<[number, number, string[]]> {
	const replacements: Array<[number, number, string[]]> = [];
	let lineIndex = 0;

	for (const chunk of chunks) {
		if (chunk.change_context) {
			const contextIdx = seekSequence(originalLines, [chunk.change_context], lineIndex);
			if (contextIdx === -2) throw new Error(`Ambiguous context '${chunk.change_context}' in ${filePath}`);
			if (contextIdx === -1) throw new Error(`Failed to find context '${chunk.change_context}' in ${filePath}`);
			lineIndex = contextIdx + 1;
		}

		if (chunk.old_lines.length === 0) {
			const insertionIdx =
				originalLines.length > 0 && originalLines[originalLines.length - 1] === ""
					? originalLines.length - 1
					: originalLines.length;
			replacements.push([insertionIdx, 0, chunk.new_lines]);
			continue;
		}

		let pattern = chunk.old_lines;
		let newSlice = chunk.new_lines;
		let found = seekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file);

		if (found === -1 && pattern.length > 0 && pattern[pattern.length - 1] === "") {
			pattern = pattern.slice(0, -1);
			if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") {
				newSlice = newSlice.slice(0, -1);
			}
			found = seekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file);
		}

		if (found === -2) {
			throw new Error(`Ambiguous match for expected lines in ${filePath}:
${chunk.old_lines.join("\n")}`);
		}

		if (found !== -1) {
			replacements.push([found, pattern.length, newSlice]);
			lineIndex = found + pattern.length;
		} else {
			throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.old_lines.join("\n")}`);
		}
	}

	replacements.sort((a, b) => a[0] - b[0]);
	return replacements;
}

function applyReplacements(lines: string[], replacements: Array<[number, number, string[]]>): string[] {
	const result = [...lines];
	for (let i = replacements.length - 1; i >= 0; i--) {
		const [startIdx, oldLen, newSegment] = replacements[i];
		result.splice(startIdx, oldLen, ...newSegment);
	}
	return result;
}

function deriveNewContentsFromChunks(filePath: string, source: TextFile, chunks: UpdateFileChunk[]) {
	const normalizedSource = normalizeNewlines(source.text);
	const hadTrailingNewline = normalizedSource.endsWith("\n");
	const originalLines = normalizedSource.split("\n");
	if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") {
		originalLines.pop();
	}

	const replacements = computeReplacements(originalLines, filePath, chunks);
	const newLines = applyReplacements(originalLines, replacements);

	if (hadTrailingNewline && (newLines.length === 0 || newLines[newLines.length - 1] !== "")) {
		newLines.push("");
	}

	const next = splitBom(applyNewlineStyle(newLines.join("\n"), source.newline));
	return { content: next.text, bom: source.bom || next.bom };
}

function countChanges(oldContent: string, newContent: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;

	for (const part of diffLines(oldContent, newContent)) {
		const lineCount = part.count ?? 0;
		if (part.added) additions += lineCount;
		if (part.removed) deletions += lineCount;
	}

	return { additions, deletions };
}

function createPatch(filePath: string, oldContent: string, newContent: string): string {
	if (oldContent === newContent) return "";
	return createTwoFilesPatch(filePath, filePath, oldContent, newContent);
}

function resolvePatchPath(cwd: string, patchPath: string): string {
	return path.resolve(cwd, patchPath);
}

function toRelative(cwd: string, filePath: string): string {
	return path.relative(cwd, filePath).replaceAll("\\", "/");
}

async function planChanges(hunks: Hunk[], cwd: string): Promise<{ fileChanges: FileChange[]; totalDiff: string }> {
	const fileChanges: FileChange[] = [];
	const states = new Map<string, PlannedState>();
	let totalDiff = "";

	async function getState(filePath: string): Promise<PlannedState> {
		const cached = states.get(filePath);
		if (cached) return cached;

		try {
			const source = await readTextFile(filePath);
			const state: PlannedState = { filePath, text: source.text, bom: source.bom, newline: source.newline, exists: true };
			states.set(filePath, state);
			return state;
		} catch {
			const state: PlannedState = { filePath, text: "", bom: false, newline: "\n", exists: false };
			states.set(filePath, state);
			return state;
		}
	}

	function setState(state: PlannedState) {
		states.set(state.filePath, state);
	}

	for (const hunk of hunks) {
		const filePath = resolvePatchPath(cwd, hunk.path);

		switch (hunk.type) {
			case "add": {
				const state = await getState(filePath);
				if (state.exists) throw new Error(`apply_patch verification failed: File already exists: ${filePath}`);

				const oldContent = state.text;
				const newContent = hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`;
				const next = splitBom(newContent);
				const diff = createPatch(filePath, oldContent, next.text);
				const { additions, deletions } = countChanges(oldContent, next.text);
				fileChanges.push({ filePath, oldContent, newContent: next.text, type: "add", diff, additions, deletions, bom: next.bom });
				setState({ filePath, text: next.text, bom: next.bom, newline: "\n", exists: true });
				totalDiff += diff + "\n";
				break;
			}

			case "update": {
				const state = await getState(filePath);
				if (!state.exists) {
					throw new Error(`apply_patch verification failed: Failed to read file to update: ${filePath}`);
				}
				const source: TextFile = { text: state.text, bom: state.bom, newline: state.newline };

				let fileUpdate: { content: string; bom: boolean };
				try {
					fileUpdate = deriveNewContentsFromChunks(filePath, source, hunk.chunks);
				} catch (error) {
					throw new Error(`apply_patch verification failed: ${error}`);
				}

				const movePath = hunk.move_path ? resolvePatchPath(cwd, hunk.move_path) : undefined;
				if (movePath) {
					const targetState = await getState(movePath);
					if (targetState.exists && movePath !== filePath) {
						throw new Error(`apply_patch verification failed: Move target already exists: ${movePath}`);
					}
				}
				const diff = createPatch(filePath, source.text, fileUpdate.content);
				const { additions, deletions } = countChanges(source.text, fileUpdate.content);
				fileChanges.push({
					filePath,
					oldContent: source.text,
					newContent: fileUpdate.content,
					type: hunk.move_path ? "move" : "update",
					movePath,
					diff,
					additions,
					deletions,
					bom: fileUpdate.bom,
				});
				if (movePath) {
					setState({ filePath, text: "", bom: false, newline: "\n", exists: false });
					setState({ filePath: movePath, text: fileUpdate.content, bom: fileUpdate.bom, newline: state.newline, exists: true });
				} else {
					setState({ filePath, text: fileUpdate.content, bom: fileUpdate.bom, newline: state.newline, exists: true });
				}
				totalDiff += diff + "\n";
				break;
			}

			case "delete": {
				const source = await getState(filePath);
				if (!source.exists) throw new Error(`apply_patch verification failed: File does not exist: ${filePath}`);
				const diff = createPatch(filePath, source.text, "");
				fileChanges.push({
					filePath,
					oldContent: source.text,
					newContent: "",
					type: "delete",
					diff,
					additions: 0,
					deletions: source.text.split("\n").length,
					bom: source.bom,
				});
				setState({ filePath, text: "", bom: false, newline: "\n", exists: false });
				totalDiff += diff + "\n";
				break;
			}
		}
	}

	return { fileChanges, totalDiff };
}

async function applyChanges(fileChanges: FileChange[]): Promise<void> {
	for (const change of fileChanges) {
		switch (change.type) {
			case "add":
			case "update":
				await mkdir(path.dirname(change.filePath), { recursive: true });
				await writeFile(change.filePath, joinBom(change.newContent, change.bom), "utf8");
				break;

			case "move":
				if (!change.movePath) break;
				await mkdir(path.dirname(change.movePath), { recursive: true });
				await writeFile(change.movePath, joinBom(change.newContent, change.bom), "utf8");
				await rm(change.filePath, { force: true });
				break;

			case "delete":
				await rm(change.filePath);
				break;
		}
	}
}

export function registerApplyPatchTool(
	server: McpServer,
	shells: ShellStore,
	recorder: ToolCallRecorder,
	mutations: FileMutationCoordinator,
) {
	return server.registerTool("apply_patch", {
		description: DESCRIPTION,
		inputSchema: {
			shell_id: shellIdSchema,
			patchText: z.string().describe("The full patch text that describes all changes to be made"),
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		},
		outputSchema: {
			message: z.string(),
			diff: z.string(),
			files: z.array(z.object({
				filePath: z.string(),
				relativePath: z.string(),
				type: z.enum(["add", "update", "delete", "move"]),
				patch: z.string(),
				additions: z.number().int().nonnegative(),
				deletions: z.number().int().nonnegative(),
				movePath: z.string().optional(),
			})),
			diagnostics: z.record(z.string(), z.unknown()),
		},
	}, async (input, extra) => invokeShellTool(recorder, shells, "apply_patch", input, async (shell) => {
		const { patchText } = input;
		const cwd = shell.cwd;
		const signal = extra.signal;
		if (signal?.aborted) throw new Error("aborted");
		if (!patchText) throw new Error("patchText is required");

		let hunks: Hunk[];
		try {
			({ hunks } = parsePatch(patchText));
		} catch (error) {
			throw new Error(`apply_patch verification failed: ${error}`);
		}

		if (hunks.length === 0) {
			const normalized = patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
			if (normalized === "*** Begin Patch\n*** End Patch") throw new Error("patch rejected: empty patch");
			throw new Error("apply_patch verification failed: no hunks found");
		}

		const mutationPaths = hunks.flatMap((hunk) => {
			const source = resolvePatchPath(cwd, hunk.path);
			if (hunk.type === "update" && hunk.move_path) {
				return [source, resolvePatchPath(cwd, hunk.move_path)];
			}
			return [source];
		});

		return mutations.runExclusive(mutationPaths, async () => {
			const { fileChanges, totalDiff } = await planChanges(hunks, cwd);
			if (signal?.aborted) throw new Error("aborted");
			const files = fileChanges.map((change) => ({
				filePath: change.filePath,
				relativePath: toRelative(cwd, change.movePath ?? change.filePath),
				type: change.type,
				patch: change.diff,
				additions: change.additions,
				deletions: change.deletions,
				movePath: change.movePath,
			}));

			// Once mutation starts, finish the planned patch rather than aborting mid-apply.
			await applyChanges(fileChanges);

			const summaryLines = fileChanges.map((change) => {
				if (change.type === "add") return `A ${toRelative(cwd, change.filePath)}`;
				if (change.type === "delete") return `D ${toRelative(cwd, change.filePath)}`;
				return `M ${toRelative(cwd, change.movePath ?? change.filePath)}`;
			});
			const output = `Success. Updated the following files:\n${summaryLines.join("\n")}`;

			const structuredContent = {
				message: output,
				diff: totalDiff,
				files,
				diagnostics: {},
			};

			return {
				content: [{ type: "text", text: output }],
				structuredContent,
				details: {
					diff: totalDiff,
					files,
					diagnostics: {},
				},
			};
		});
	}));
}
