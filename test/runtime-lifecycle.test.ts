import assert from "node:assert/strict";
import test from "node:test";
import { DrainGate } from "../src/runtime/drain-gate.js";
import { InvocationGate } from "../src/tools/invocation-gate.js";

test("drain gate rejects new leases after close and resolves when active work drains", async () => {
  const gate = new DrainGate();
  const first = gate.enter();
  const second = gate.enter();
  assert.ok(first);
  assert.ok(second);
  assert.equal(gate.activeCount, 2);

  gate.close();
  assert.equal(gate.isAccepting, false);
  assert.equal(gate.enter(), undefined);

  let drained = false;
  const drainedPromise = gate.drained().then(() => {
    drained = true;
  });
  first.release();
  assert.equal(drained, false);
  second.release();
  await drainedPromise;
  assert.equal(drained, true);

  first.release();
  assert.equal(gate.activeCount, 0);
});

test("invocation gate lets admitted work finish but rejects work admitted after close", async () => {
  const gate = new InvocationGate();
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });

  const running = gate.run(async () => {
    await blocker;
    return "done";
  });
  assert.equal(gate.activeCount, 1);

  gate.close();
  await assert.rejects(() => gate.run(async () => "late"), /Server is shutting down/);
  assert.equal(gate.activeCount, 1);

  release();
  assert.equal(await running, "done");
  await gate.drained();
  assert.equal(gate.activeCount, 0);
});

test("invocation gate converts forced shutdown of cancellable work into an interruption error", async () => {
  const gate = new InvocationGate();
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });

  const running = gate.run(
    async (invocation) => invocation.execute(async () => {
      await blocker;
      return "would-have-succeeded";
    }),
    { shutdownCancellable: true },
  );

  gate.close();
  assert.equal(gate.interruptCancellable(), 1);
  release();
  await assert.rejects(running, /Tool invocation interrupted by server shutdown/);
  await gate.drained();
});
