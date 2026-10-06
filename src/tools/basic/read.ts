import { createReadStream } from "node:fs";
import { extname } from "node:path";
import { resolveHostPath } from "../../host/paths.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "./text-limit.js";

const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

export type ReadTextInput = {
  path: string;
  offset?: number;
  limit?: number;
};

export type BasicToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown> | null;
};

export async function readTextFile(
  cwd: string,
  input: ReadTextInput,
  signal?: AbortSignal,
): Promise<BasicToolResult> {
  if (imageExtensions.has(extname(input.path).toLowerCase())) {
    throw new Error("read only supports text files. Use read_image for image files.");
  }

  const offset = input.offset ?? 1;
  const requestedLimit = input.limit ?? DEFAULT_MAX_LINES;
  const lineLimit = Math.min(requestedLimit, DEFAULT_MAX_LINES);
  const absolutePath = resolveHostPath(cwd, input.path);
  const stream = createReadStream(absolutePath, { signal });

  const lines: string[] = [];
  let selectedBytes = 0;
  let lineNumber = 1;
  let linesSeen = 0;
  let currentParts: Buffer[] = [];
  let currentBytes = 0;
  let capacityReached = false;
  let truncated = false;
  let firstSelectedLineTooLarge = false;
  let stopped = false;
  let sawBytes = false;
  let endedWithNewline = false;

  const appendPart = (part: Buffer): boolean => {
    if (lineNumber < offset || part.length === 0) return true;
    const separatorBytes = lines.length > 0 ? 1 : 0;
    if (selectedBytes + separatorBytes + currentBytes + part.length > DEFAULT_MAX_BYTES) {
      truncated = true;
      firstSelectedLineTooLarge = lines.length === 0;
      stopped = true;
      return false;
    }
    currentParts.push(part);
    currentBytes += part.length;
    return true;
  };

  const finishLine = () => {
    linesSeen = lineNumber;
    if (lineNumber >= offset && !capacityReached) {
      const raw = currentParts.length === 0 ? "" : Buffer.concat(currentParts, currentBytes).toString("utf8");
      const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (lines.length > 0) selectedBytes += 1;
      selectedBytes += Buffer.byteLength(text, "utf8");
      lines.push(text);
      if (lines.length >= lineLimit) capacityReached = true;
    }
    currentParts = [];
    currentBytes = 0;
    lineNumber++;
  };

  try {
    outer: for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (chunk.length === 0) continue;
      sawBytes = true;

      if (capacityReached) {
        truncated = true;
        break;
      }

      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== 0x0a) continue;
        if (!appendPart(chunk.subarray(start, i))) break outer;
        finishLine();
        endedWithNewline = true;
        start = i + 1;

        if (capacityReached && start < chunk.length) {
          truncated = true;
          break outer;
        }
      }

      if (start < chunk.length) {
        endedWithNewline = false;
        if (!appendPart(chunk.subarray(start))) break;
      }
    }

    if (!stopped && !capacityReached && (!endedWithNewline || !sawBytes)) {
      finishLine();
    }
  } catch (error) {
    if (signal?.aborted) throw new Error("Operation aborted");
    throw error;
  } finally {
    stream.destroy();
  }

  if (!firstSelectedLineTooLarge && linesSeen < offset && !stopped) {
    throw new Error(`Offset ${offset} is beyond end of file (${linesSeen} lines total)`);
  }

  if (firstSelectedLineTooLarge) {
    return {
      content: [{
        type: "text",
        text: `[Line ${offset} exceeds the ${DEFAULT_MAX_BYTES / 1024} KiB read limit. Use bash with byte-oriented tools to inspect it.]`,
      }],
      details: {
        truncated: true,
        max_bytes: DEFAULT_MAX_BYTES,
      },
    };
  }

  let text = lines.join("\n");
  const details: Record<string, unknown> = {};
  if (truncated) {
    const nextOffset = offset + lines.length;
    text += `\n\n[Output truncated. Use offset=${nextOffset} to continue.]`;
    details.truncated = true;
    details.next_offset = nextOffset;
    details.max_lines = DEFAULT_MAX_LINES;
    details.max_bytes = DEFAULT_MAX_BYTES;
  }

  return {
    content: [{ type: "text", text }],
    details: Object.keys(details).length > 0 ? details : null,
  };
}
