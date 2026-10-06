import { spawn, type ChildProcess } from "node:child_process";

type TrackedProcess = {
  child: ChildProcess;
  processGroup: boolean;
};

const SHUTDOWN_TERM_GRACE_MS = 1_000;

export class ProcessSupervisor {
  private readonly tracked = new Map<ChildProcess, TrackedProcess>();
  private closePromise: Promise<void> | undefined;

  track(child: ChildProcess, options: { processGroup?: boolean } = {}): () => void {
    const entry: TrackedProcess = {
      child,
      processGroup: options.processGroup ?? false,
    };

    if (this.closePromise) {
      signalProcess(entry, "SIGKILL");
      throw new Error("Process supervisor is closing");
    }

    this.tracked.set(child, entry);
    const cleanup = () => {
      this.tracked.delete(child);
      child.off("close", cleanup);
      child.off("error", cleanup);
    };
    child.once("close", cleanup);
    child.once("error", cleanup);
    return cleanup;
  }

  terminate(child: ChildProcess): void {
    signalProcess(this.tracked.get(child) ?? { child, processGroup: false }, "SIGKILL");
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeTracked();
    return this.closePromise;
  }

  private async closeTracked(): Promise<void> {
    const entries = [...this.tracked.values()];
    const waits = entries.map(({ child }) => waitForChild(child));

    for (const entry of entries) signalProcess(entry, "SIGTERM");
    await waitForEntriesOrTimeout(entries, SHUTDOWN_TERM_GRACE_MS);

    for (const entry of entries) {
      if (isEntryRunning(entry)) signalProcess(entry, "SIGKILL");
    }
    await Promise.all(waits);
    await waitForEntriesOrTimeout(entries, SHUTDOWN_TERM_GRACE_MS);
    this.tracked.clear();
  }
}

function signalProcess({ child, processGroup }: TrackedProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) {
    child.kill(signal);
    return;
  }

  if (processGroup && process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall through to killing the direct child.
    }
  }

  if (processGroup && process.platform === "win32" && signal === "SIGKILL") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
        detached: true,
      }).unref();
      return;
    } catch {
      // Fall through to killing the direct child.
    }
  }

  try {
    child.kill(signal);
  } catch {
    // The process may already have exited.
  }
}

function isRunning(child: ChildProcess): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

function isEntryRunning(entry: TrackedProcess): boolean {
  if (entry.processGroup && process.platform !== "win32" && entry.child.pid !== undefined) {
    return processGroupExists(entry.child.pid);
  }
  return isRunning(entry.child);
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: any) {
    return error?.code !== "ESRCH";
  }
}

async function waitForEntriesOrTimeout(entries: TrackedProcess[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (entries.some(isEntryRunning) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function waitForChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
    return Promise.resolve();
  }

  return new Promise((resolveWait) => {
    const done = () => {
      child.off("close", done);
      child.off("error", done);
      resolveWait();
    };
    child.once("close", done);
    child.once("error", done);
  });
}
