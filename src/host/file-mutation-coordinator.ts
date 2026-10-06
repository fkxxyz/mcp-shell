import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

type Registration = {
  wait: Promise<void>;
  held: Promise<void>;
  release: () => void;
};

export class FileMutationCoordinator {
  private readonly queues = new Map<string, Promise<void>>();
  private registrationQueue = Promise.resolve();

  async runExclusive<T>(paths: string[], operation: () => Promise<T>): Promise<T> {
    const keys = [...new Set(await Promise.all(paths.map(canonicalMutationKey)))].sort();
    if (keys.length === 0) return operation();

    const registration = this.registrationQueue.then(() => this.register(keys));
    this.registrationQueue = registration.then(
      () => undefined,
      () => undefined,
    );

    const { wait, held, release } = await registration;
    await wait;
    try {
      return await operation();
    } finally {
      release();
      for (const key of keys) {
        if (this.queues.get(key) === held) this.queues.delete(key);
      }
    }
  }

  private register(keys: string[]): Registration {
    const previous = keys.map((key) => this.queues.get(key) ?? Promise.resolve());
    const wait = Promise.all(previous).then(() => undefined);

    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const held = wait.then(() => gate);

    for (const key of keys) this.queues.set(key, held);
    return { wait, held, release };
  }
}

async function canonicalMutationKey(path: string): Promise<string> {
  const resolved = resolve(path);
  const suffix: string[] = [];
  let current = resolved;

  while (true) {
    try {
      const ancestor = await realpath(current);
      return suffix.length === 0 ? ancestor : join(ancestor, ...suffix);
    } catch (error: any) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;

      const parent = dirname(current);
      if (parent === current) return resolved;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}
