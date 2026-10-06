import { spawn, type ChildProcess } from "node:child_process";

type TrackedProcess = {
  child: ChildProcess;
  processGroup: boolean;
};

export class ProcessSupervisor {
  private readonly tracked = new Map<ChildProcess, TrackedProcess>();
  private closePromise: Promise<void> | undefined;

  track(child: ChildProcess, options: { processGroup?: boolean } = {}): () => void {
    const entry: TrackedProcess = {
      child,
      processGroup: options.processGroup ?? false,
    };

    if (this.closePromise) {
      terminate(entry);
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
    terminate(this.tracked.get(child) ?? { child, processGroup: false });
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeTracked();
    return this.closePromise;
  }

  private async closeTracked(): Promise<void> {
    const entries = [...this.tracked.values()];
    for (const entry of entries) terminate(entry);
    await Promise.all(entries.map(({ child }) => waitForChild(child)));
    this.tracked.clear();
  }
}

function terminate({ child, processGroup }: TrackedProcess): void {
  const pid = child.pid;
  if (!pid) {
    child.kill("SIGKILL");
    return;
  }

  if (processGroup && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // Fall through to killing the direct child.
    }
  }

  if (processGroup && process.platform === "win32") {
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
    child.kill("SIGKILL");
  } catch {
    // The process may already have exited.
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
