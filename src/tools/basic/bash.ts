import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import type { CommandPathPolicy } from "../../command-path.js";
import { applyCommandPath } from "../../command-path.js";
import type { ProcessSupervisor } from "../../host/process-supervisor.js";
import type { BasicToolResult } from "./read.js";
import { BoundedTextTail, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "./text-limit.js";

const MAX_TIMEOUT_MS = 2_147_483_647;

export async function runBash(
  cwd: string,
  input: { command: string; timeout?: number },
  commandPath: CommandPathPolicy,
  processes: ProcessSupervisor,
  signal?: AbortSignal,
): Promise<BasicToolResult> {
  if (signal?.aborted) throw new Error("Command aborted");

  const timeoutMs = resolveTimeoutMs(input.timeout);
  const executable = resolveBashExecutable();
  const child = spawn(executable, ["-c", input.command], {
    cwd,
    detached: true,
    env: applyCommandPath(process.env, commandPath),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const untrack = processes.track(child, { processGroup: true });
  const output = new BoundedTextTail();

  child.stdout?.on("data", (chunk: Buffer) => output.append(chunk));
  child.stderr?.on("data", (chunk: Buffer) => output.append(chunk));

  let timedOut = false;
  let aborted = false;
  let timeoutHandle: NodeJS.Timeout | undefined;

  const abort = () => {
    aborted = true;
    processes.terminate(child);
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();

  if (timeoutMs !== undefined) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      processes.terminate(child);
    }, timeoutMs);
  }

  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  try {
    ({ code: exitCode, signal: exitSignal } = await waitForExit(child));
  } catch (error) {
    const snapshot = output.finish();
    if (aborted || signal?.aborted) throw new Error(withStatus(formatOutput(snapshot), "Command aborted"));
    if (timedOut) throw new Error(withStatus(formatOutput(snapshot), `Command timed out after ${input.timeout} seconds`));
    throw error;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    signal?.removeEventListener("abort", abort);
    untrack();
  }

  const snapshot = output.finish();
  const text = formatOutput(snapshot);
  if (aborted || signal?.aborted) throw new Error(withStatus(text, "Command aborted"));
  if (timedOut) throw new Error(withStatus(text, `Command timed out after ${input.timeout} seconds`));
  if (exitCode !== 0) {
    const status = exitCode === null
      ? `Command terminated by signal ${exitSignal ?? "unknown"}`
      : `Command exited with code ${exitCode}`;
    throw new Error(withStatus(text, status));
  }

  return {
    content: [{ type: "text", text: text || "(no output)" }],
    details: snapshot.truncated
      ? {
          truncated: true,
          max_lines: DEFAULT_MAX_LINES,
          max_bytes: DEFAULT_MAX_BYTES,
        }
      : null,
  };
}

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  const timeoutMs = timeout * 1_000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1_000} seconds`);
  }
  return timeoutMs;
}

function resolveBashExecutable(): string {
  if (process.platform === "win32") return "bash";
  if (existsSync("/bin/bash")) return "/bin/bash";
  throw new Error("bash executable not found at /bin/bash");
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      child.off("close", onClose);
      reject(error);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      child.off("error", onError);
      resolve({ code, signal });
    };
    child.once("error", onError);
    child.once("close", onClose);
  });
}

function formatOutput(snapshot: { text: string; truncated: boolean }): string {
  if (!snapshot.truncated) return snapshot.text;
  const footer =
    `[Output truncated to the last ${DEFAULT_MAX_LINES} lines / ${DEFAULT_MAX_BYTES / 1024} KiB. ` +
    "Redirect command output to a file if complete output is required.]";
  return snapshot.text ? `${snapshot.text}\n\n${footer}` : footer;
}

function withStatus(text: string, status: string): string {
  return text ? `${text}\n\n${status}` : status;
}
