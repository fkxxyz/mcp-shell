export type DrainLease = {
  release(): void;
};

export class DrainGate {
  private accepting = true;
  private active = 0;
  private readonly waiters = new Set<() => void>();

  enter(): DrainLease | undefined {
    if (!this.accepting) return undefined;

    this.active++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active--;
        this.resolveIfDrained();
      },
    };
  }

  close(): void {
    this.accepting = false;
    this.resolveIfDrained();
  }

  get activeCount(): number {
    return this.active;
  }

  get isAccepting(): boolean {
    return this.accepting;
  }

  drained(): Promise<void> {
    if (this.active === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.add(resolve));
  }

  private resolveIfDrained(): void {
    if (this.active !== 0) return;
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
}
