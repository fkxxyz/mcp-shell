import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { ActivityTracker } from "../src/observability/activity-tracker.js";
import {
  ToolCallRecorder,
  withToolLogContext,
} from "../src/observability/tool-call-recorder.js";
import { ToolLogStore } from "../src/observability/tool-log-store.js";

test("tool logs preserve complete calls, shell identity, and activity summaries", async () => {
  await withToolLogs(2, async ({ dir, recorder, tracker }) => {
    await withToolLogContext({ session: "session-1", actor: "actor-1" }, async () => {
      const input = { command: "printf hello", nested: { value: "complete input" } };
      const output = { content: [{ type: "text", text: "complete output" }] };

      assert.deepEqual(
        await recorder.run(
          { tool: "bash", input, shellId: 42, cwd: "/workspace" },
          async () => output,
        ),
        output,
      );

      const firstIndex = await readIndex(dir);
      assert.equal(firstIndex.length, 1);
      assert.equal(firstIndex[0].tool, "bash");
      assert.equal(firstIndex[0].shell_id, 42);
      assert.equal(firstIndex[0].cwd, "/workspace");
      assert.equal(firstIndex[0].session, "session-1");
      assert.equal(firstIndex[0].actor, "actor-1");
      assert.equal(firstIndex[0].status, "success");
      assert.equal("input_preview" in firstIndex[0], false, "input previews must not outlive payload retention in the append-only index");

      const firstPayloadPath = join(dir, firstIndex[0].file);
      const firstPayload = JSON.parse(gunzipSync(await readFile(firstPayloadPath)).toString("utf8"));
      assert.deepEqual(firstPayload.input, input);
      assert.deepEqual(firstPayload.output, output);

      const snapshot = tracker.snapshot();
      assert.equal(snapshot.workspaces.length, 1);
      assert.equal(snapshot.workspaces[0]?.cwd, "/workspace");
      assert.equal(snapshot.workspaces[0]?.recentCalls[0]?.tool, "bash");
      assert.equal("input" in (snapshot.workspaces[0]?.recentCalls[0] ?? {}), false);
      assert.deepEqual(snapshot.workspaces[0]?.recentCalls[0]?.inputPreview, input);

      await assert.rejects(
        () => recorder.run({ tool: "edit", input: { path: "a.ts" }, cwd: "/workspace" }, async () => {
          throw new Error("edit failed");
        }),
        /edit failed/,
      );

      await recorder.run({ tool: "read", input: { path: "b.ts" }, cwd: "/workspace" }, async () => ({
        content: [{ type: "text", text: "third call" }],
      }));

      const index = await readIndex(dir);
      assert.equal(index.length, 3, "metadata history remains append-only");

      const payloadFiles = await readPayloadFiles(dir);
      assert.equal(payloadFiles.length, 2);
      assert.equal(payloadFiles.includes(firstIndex[0].file.replace("calls/", "")), false);

      const errorPayload = JSON.parse(
        gunzipSync(await readFile(join(dir, index[1].file))).toString("utf8"),
      );
      assert.equal(errorPayload.status, "error");
      assert.equal(errorPayload.error.message, "edit failed");
      assert.deepEqual(errorPayload.input, { path: "a.ts" });
    });
  });
});

test("tool log retention rebuilds from disk and prunes existing payloads on initialization", async () => {
  await withToolLogs(2, async ({ dir, recorder }) => {
    const callsDir = join(dir, "calls");
    await mkdir(callsDir, { recursive: true });
    await writeFile(join(callsDir, "20000101T000000.000Z-0000000001-old.json.gz"), "old");
    await writeFile(join(callsDir, "20010101T000000.000Z-0000000002-middle.json.gz"), "middle");
    await writeFile(join(callsDir, "20020101T000000.000Z-0000000003-new.json.gz"), "new");

    await recorder.run({ tool: "read", input: { path: "current.txt" } }, async () => ({ ok: true }));

    const payloadFiles = await readPayloadFiles(dir);
    assert.equal(payloadFiles.length, 2);
    assert.equal(payloadFiles.includes("20000101T000000.000Z-0000000001-old.json.gz"), false);
    assert.equal(payloadFiles.includes("20010101T000000.000Z-0000000002-middle.json.gz"), false);
    assert.equal(payloadFiles.includes("20020101T000000.000Z-0000000003-new.json.gz"), true);
  });
});

test("tool log retention does not rescan the payload directory during steady-state writes", async () => {
  await withToolLogs(2, async ({ dir, recorder }) => {
    await recorder.run({ tool: "first", input: {} }, async () => ({ ok: true }));

    const external = "19990101T000000.000Z-0000000001-external.json.gz";
    await writeFile(join(dir, "calls", external), "external");

    await recorder.run({ tool: "second", input: {} }, async () => ({ ok: true }));

    const payloadFiles = await readPayloadFiles(dir);
    assert.equal(payloadFiles.length, 3);
    assert.equal(payloadFiles.includes(external), true);
  });
});

test("tool log retention keeps the newest call by start order when calls finish out of order", async () => {
  await withToolLogs(1, async ({ dir, recorder }) => {
    let releaseSlow!: () => void;
    const slow = recorder.run({ tool: "slow", input: {} }, () => new Promise<void>((resolve) => {
      releaseSlow = resolve;
    }));

    await recorder.run({ tool: "fast", input: {} }, async () => ({ ok: true }));
    releaseSlow();
    await slow;

    const index = await readIndex(dir);
    const fast = index.find((entry) => entry.tool === "fast");
    const slowEntry = index.find((entry) => entry.tool === "slow");
    assert.ok(fast);
    assert.ok(slowEntry);

    const payloadFiles = await readPayloadFiles(dir);
    assert.deepEqual(payloadFiles, [fast.file.replace("calls/", "")]);
    assert.equal(payloadFiles.includes(slowEntry.file.replace("calls/", "")), false);
  });
});

test("tool log retention serializes concurrent writes and enforces the exact limit", async () => {
  await withToolLogs(5, async ({ dir, recorder }) => {
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        recorder.run({ tool: "concurrent", input: { i } }, async () => ({ i }))),
    );

    const payloadFiles = await readPayloadFiles(dir);
    assert.equal(payloadFiles.length, 5);
    assert.equal(new Set(payloadFiles).size, 5);
    assert.equal((await readIndex(dir)).length, 30);
  });
});

test("tool log retention still governs a payload when index persistence fails", async () => {
  await withToolLogs(1, async ({ dir, recorder }) => {
    const callsDir = join(dir, "calls");
    await mkdir(callsDir, { recursive: true });
    const oldPayload = "20000101T000000.000Z-0000000001-old.json.gz";
    await writeFile(join(callsDir, oldPayload), "old");
    await mkdir(join(dir, "index.jsonl"));

    const previousConsoleError = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(
        await recorder.run({ tool: "read", input: { path: "current.txt" } }, async () => ({ ok: true })),
        { ok: true },
      );
    } finally {
      console.error = previousConsoleError;
    }

    const payloadFiles = await readPayloadFiles(dir);
    assert.equal(payloadFiles.length, 1);
    assert.equal(payloadFiles.includes(oldPayload), false);
  });
});

test("logging failure never replaces the original tool error", async () => {
  await withToolLogs(1, async ({ dir, recorder }) => {
    await mkdir(join(dir, "index.jsonl"), { recursive: true });
    const previousConsoleError = console.error;
    console.error = () => {};
    try {
      await assert.rejects(
        () => recorder.run({ tool: "bash", input: {} }, async () => {
          throw new Error("original failure");
        }),
        /original failure/,
      );
    } finally {
      console.error = previousConsoleError;
    }
  });
});

test("tool log retention removes orphaned tool-log temp files during initialization", async () => {
  await withToolLogs(2, async ({ dir, recorder }) => {
    const callsDir = join(dir, "calls");
    await mkdir(callsDir, { recursive: true });
    const orphan =
      ".20000101T000000.000Z-0000000001-00000000-0000-4000-8000-000000000000.json.gz." +
      "00000000-0000-4000-8000-000000000001.tmp";
    const unrelated = "unrelated.tmp";
    await writeFile(join(callsDir, orphan), "orphan");
    await writeFile(join(callsDir, unrelated), "unrelated");

    await recorder.run({ tool: "read", input: {} }, async () => ({ ok: true }));

    const entries = await readdir(callsDir);
    assert.equal(entries.includes(orphan), false);
    assert.equal(entries.includes(unrelated), true);
  });
});

test("readRecent tail-reads newest entries and preserves UTF-8 paths", async () => {
  await withToolLogs(10, async ({ store, recorder }) => {
    for (let i = 0; i < 5; i++) {
      await recorder.run(
        { tool: "read", input: { i }, shellId: i + 1, cwd: `/工作区/项目-${i}` },
        async () => ({ i }),
      );
    }

    const recent = await store.readRecent(2);
    assert.equal(recent.length, 2);
    assert.deepEqual(recent.map((entry) => entry.cwd), ["/工作区/项目-3", "/工作区/项目-4"]);
  });
});

async function readIndex(dir: string): Promise<any[]> {
  const raw = await readFile(join(dir, "index.jsonl"), "utf8");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function readPayloadFiles(dir: string): Promise<string[]> {
  return (await readdir(join(dir, "calls")))
    .filter((name) => name.endsWith(".json.gz"))
    .sort();
}

async function withToolLogs(
  maxCalls: number,
  callback: (context: {
    dir: string;
    store: ToolLogStore;
    tracker: ActivityTracker;
    recorder: ToolCallRecorder;
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-tool-logs-test-"));
  const store = new ToolLogStore(dir, maxCalls);
  const tracker = new ActivityTracker(maxCalls);
  const recorder = new ToolCallRecorder(store, tracker);

  try {
    await callback({ dir, store, tracker, recorder });
  } finally {
    tracker.close();
    await rm(dir, { recursive: true, force: true });
  }
}
