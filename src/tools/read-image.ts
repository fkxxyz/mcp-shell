import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { applyCommandPath, type CommandPathPolicy } from "../command-path.js";
import type { ShellStore } from "../shell-store.js";
import { recordToolCall } from "../tool-logs.js";
import { shellIdSchema } from "./shell.js";

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_INPUT_PIXELS = 100_000_000;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

const outputProfiles = [
  { maxDimension: 2000, quality: 90 },
  { maxDimension: 1600, quality: 80 },
  { maxDimension: 1200, quality: 70 },
];

function detectRasterMimeType(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }

  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  return undefined;
}

function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  for (let offset = 2; offset + 8 < bytes.length; ) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }

    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 7 || offset + segmentLength > bytes.length) break;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      };
    }

    offset += segmentLength;
  }
}

async function normalizeWithImageMagick(
  bytes: Uint8Array,
  maxDimension: number,
  quality: number,
  signal: AbortSignal | undefined,
  commandPath: CommandPathPolicy,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("magick", [
      "-limit", "memory", "256MiB",
      "-limit", "map", "512MiB",
      "-limit", "area", `${MAX_INPUT_PIXELS}P`,
      "-",
      "-auto-orient",
      "-resize", `${maxDimension}x${maxDimension}>`,
      "-strip",
      "-background", "#ffffff",
      "-alpha", "remove",
      "-quality", String(quality),
      "jpeg:-",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      env: applyCommandPath(process.env, commandPath),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const abort = () => child.kill("SIGTERM");

    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on("error", () => undefined);
    child.once("error", (error) => reject(new Error(`Could not start ImageMagick: ${error.message}`)));
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) {
        reject(new Error("Image processing was cancelled."));
        return;
      }
      if (code !== 0) {
        const message = Buffer.concat(stderr).toString("utf8").trim();
        reject(new Error(`Could not normalize image${message ? `: ${message}` : "."}`));
        return;
      }
      resolve(Buffer.concat(stdout));
    });
    child.stdin.end(bytes);
  });
}

async function encodeForVision(
  bytes: Uint8Array,
  signal: AbortSignal | undefined,
  commandPath: CommandPathPolicy,
) {
  for (const profile of outputProfiles) {
    const data = await normalizeWithImageMagick(bytes, profile.maxDimension, profile.quality, signal, commandPath);

    if (data.byteLength <= MAX_OUTPUT_BYTES) {
      const dimensions = jpegDimensions(data);
      if (!dimensions) throw new Error("Could not determine normalized image dimensions.");
      return { data: data.toString("base64"), ...dimensions };
    }
  }

  throw new Error(`Image remains larger than ${MAX_OUTPUT_BYTES / 1024 / 1024} MiB after resizing.`);
}

export async function readImage(
  cwd: string,
  inputPath: string,
  signal: AbortSignal | undefined,
  commandPath: CommandPathPolicy,
) {
  const imagePath = resolve(cwd, expandHomePath(inputPath));
  const imageStat = await stat(imagePath);
  if (!imageStat.isFile()) {
    throw new Error("Image path must refer to a regular file.");
  }
  if (imageStat.size > MAX_INPUT_BYTES) {
    throw new Error(`Image exceeds ${MAX_INPUT_BYTES / 1024 / 1024} MiB input limit.`);
  }

  const bytes = await readFile(imagePath);
  const sourceMimeType = detectRasterMimeType(bytes);
  if (!sourceMimeType) {
    throw new Error("Unsupported image format. Use PNG, JPEG, GIF, or WebP.");
  }

  const image = await encodeForVision(bytes, signal, commandPath);
  return {
    content: [
      {
        type: "text" as const,
        text: `Image loaded: ${imagePath} (${image.width}x${image.height}, normalized from ${sourceMimeType}).`,
      },
      {
        type: "image" as const,
        data: image.data,
        mimeType: "image/jpeg",
      },
    ],
  };
}

export function registerReadImageTool(server: McpServer, shells: ShellStore, commandPath: CommandPathPolicy) {
  return server.registerTool("read_image", {
    title: "Read Image",
    description:
      "Inspect a workspace image when visual details affect the task, such as a screenshot, mockup, chart, diagram, or rendered UI. Do not use for source files or when text extraction alone is sufficient. The image is normalized for visual inspection before it is returned to the client.",
    inputSchema: {
      shell_id: shellIdSchema,
      path: z.string().describe(
        "Path to a PNG, JPEG, GIF, or WebP image. Relative paths resolve from the shell root; absolute paths and ~/ home paths are supported.",
      ),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async (input, extra) => recordToolCall("read_image", input, () => {
    const cwd = shells.require(input.shell_id).cwd;
    return readImage(cwd, input.path, extra.signal, commandPath);
  }));
}
