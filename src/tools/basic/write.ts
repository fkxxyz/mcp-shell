import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FileMutationCoordinator } from "../../host/file-mutation-coordinator.js";
import { resolveHostPath } from "../../host/paths.js";
import type { BasicToolResult } from "./read.js";

export async function writeTextFile(
  cwd: string,
  input: { path: string; content: string },
  coordinator: FileMutationCoordinator,
  signal?: AbortSignal,
): Promise<BasicToolResult> {
  const absolutePath = resolveHostPath(cwd, input.path);

  return coordinator.runExclusive([absolutePath], async () => {
    throwIfAborted(signal);
    await mkdir(dirname(absolutePath), { recursive: true });
    throwIfAborted(signal);
    await writeFile(absolutePath, input.content, "utf8");
    throwIfAborted(signal);

    return {
      content: [{
        type: "text",
        text: `Successfully wrote ${Buffer.byteLength(input.content, "utf8")} bytes to ${input.path}`,
      }],
      details: null,
    };
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Operation aborted");
}
