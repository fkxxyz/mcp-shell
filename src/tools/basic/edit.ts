import { readFile, writeFile } from "node:fs/promises";
import { createTwoFilesPatch } from "diff";
import type { FileMutationCoordinator } from "../../host/file-mutation-coordinator.js";
import { resolveHostPath } from "../../host/paths.js";
import type { BasicToolResult } from "./read.js";

export type TextEdit = {
  oldText: string;
  newText: string;
};

type MatchedEdit = {
  index: number;
  length: number;
  replacement: string;
  editIndex: number;
};

export async function editTextFile(
  cwd: string,
  input: { path: string; edits: TextEdit[] },
  coordinator: FileMutationCoordinator,
  signal?: AbortSignal,
): Promise<BasicToolResult> {
  const absolutePath = resolveHostPath(cwd, input.path);

  return coordinator.runExclusive([absolutePath], async () => {
    throwIfAborted(signal);

    let raw: string;
    try {
      raw = await readFile(absolutePath, "utf8");
    } catch (error: any) {
      const code = typeof error?.code === "string" ? ` Error code: ${error.code}.` : "";
      throw new Error(`Could not edit file: ${input.path}.${code}`);
    }
    throwIfAborted(signal);

    const hasBom = raw.startsWith("\uFEFF");
    const content = hasBom ? raw.slice(1) : raw;
    const lineEnding = detectLineEnding(content);
    const normalized = normalizeLineEndings(content);
    const edits = input.edits.map((edit) => ({
      oldText: normalizeLineEndings(edit.oldText),
      newText: normalizeLineEndings(edit.newText),
    }));

    const matched: MatchedEdit[] = edits.map((edit, editIndex) => {
      if (edit.oldText.length === 0) {
        throw new Error(editErrorPrefix(editIndex, edits.length) + `oldText must not be empty in ${input.path}.`);
      }

      const index = normalized.indexOf(edit.oldText);
      if (index === -1) {
        throw new Error(
          editErrorPrefix(editIndex, edits.length) +
          `Could not find the exact text in ${input.path}. oldText must match exactly after line-ending normalization.`,
        );
      }

      if (normalized.indexOf(edit.oldText, index + 1) !== -1) {
        throw new Error(
          editErrorPrefix(editIndex, edits.length) +
          `oldText occurs more than once in ${input.path}. Include more context so it is unique.`,
        );
      }

      return {
        index,
        length: edit.oldText.length,
        replacement: edit.newText,
        editIndex,
      };
    });

    matched.sort((a, b) => a.index - b.index);
    for (let i = 1; i < matched.length; i++) {
      const previous = matched[i - 1];
      const current = matched[i];
      if (previous.index + previous.length > current.index) {
        throw new Error(
          `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${input.path}. Merge them into one edit or target disjoint regions.`,
        );
      }
    }

    let next = normalized;
    for (let i = matched.length - 1; i >= 0; i--) {
      const edit = matched[i];
      next = next.slice(0, edit.index) + edit.replacement + next.slice(edit.index + edit.length);
    }

    if (next === normalized) {
      throw new Error(`No changes made to ${input.path}. The replacements produced identical content.`);
    }

    const finalContent = (hasBom ? "\uFEFF" : "") + restoreLineEndings(next, lineEnding);
    await writeFile(absolutePath, finalContent, "utf8");
    throwIfAborted(signal);

    const patch = createTwoFilesPatch(input.path, input.path, normalized, next);
    return {
      content: [{
        type: "text",
        text: `Successfully replaced ${edits.length} block(s) in ${input.path}.`,
      }],
      details: {
        diff: patch,
        patch,
      },
    };
  });
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function detectLineEnding(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function restoreLineEndings(text: string, lineEnding: "\r\n" | "\n"): string {
  return lineEnding === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function editErrorPrefix(editIndex: number, count: number): string {
  return count === 1 ? "" : `edits[${editIndex}]: `;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Operation aborted");
}
