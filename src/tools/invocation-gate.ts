import { DrainGate } from "../runtime/drain-gate.js";

export type InvocationContext = {
  execute<T>(operation: () => Promise<T>): Promise<T>;
};

type InvocationToken = {
  interrupted: boolean;
};

export class InvocationGate {
  private readonly gate = new DrainGate();
  private readonly cancellable = new Set<InvocationToken>();

  async run<T>(
    operation: (context: InvocationContext) => Promise<T>,
    options: { shutdownCancellable?: boolean } = {},
  ): Promise<T> {
    const lease = this.gate.enter();
    if (!lease) throw new Error("Server is shutting down");

    const token = options.shutdownCancellable ? { interrupted: false } : undefined;
    if (token) this.cancellable.add(token);
    const context: InvocationContext = {
      execute: (execute) => executeWithShutdownState(execute, token),
    };

    try {
      return await operation(context);
    } finally {
      if (token) this.cancellable.delete(token);
      lease.release();
    }
  }

  close(): void {
    this.gate.close();
  }

  get activeCount(): number {
    return this.gate.activeCount;
  }

  interruptCancellable(): number {
    for (const token of this.cancellable) token.interrupted = true;
    return this.cancellable.size;
  }

  drained(): Promise<void> {
    return this.gate.drained();
  }
}

async function executeWithShutdownState<T>(
  operation: () => Promise<T>,
  token: InvocationToken | undefined,
): Promise<T> {
  if (token?.interrupted) throw shutdownInterruptedError();

  try {
    const result = await operation();
    if (token?.interrupted) throw shutdownInterruptedError();
    return result;
  } catch (error) {
    if (token?.interrupted) throw shutdownInterruptedError();
    throw error;
  }
}

function shutdownInterruptedError(): Error {
  return new Error("Tool invocation interrupted by server shutdown");
}
