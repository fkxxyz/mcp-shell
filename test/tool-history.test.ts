import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { ObservabilityQuery } from "../src/observability/observability-query.js";
import { ActivityTracker } from "../src/observability/activity-tracker.js";
import {
  ToolCallRecorder,
  withToolLogContext,
} from "../src/observability/tool-call-recorder.js";
import type { ToolCallRecord } from "../src/observability/tool-call.js";
import { ObservabilityStore } from "../src/observability/observability-store.js";
import { ShellStore } from "../src/shell-store.js";

test("tool history preserves complete calls, durable previews, and exact retention", async () => {
  await withToolHistory(2, async ({ dir, store, recorder }) => {
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

      const first = store.readRecent(1)[0]!;
      assert.equal(first.tool, "bash");
      assert.equal(first.shellId, 42);
      assert.equal(first.cwd, "/workspace");
      assert.deepEqual(first.inputPreview, input);
      const firstDetail = await store.readCall(first.id);
      assert.equal(firstDetail.kind, "found");
      if (firstDetail.kind === "found") {
        assert.equal(firstDetail.record.session, "session-1");
        assert.equal(firstDetail.record.actor, "actor-1");
        assert.deepEqual(firstDetail.record.input, input);
        assert.deepEqual(firstDetail.record.output, output);
      }

      await assert.rejects(
        () => recorder.run({ tool: "edit", input: { path: "a.ts" }, cwd: "/workspace" }, async () => {
          throw new Error("edit failed");
        }),
        /edit failed/,
      );

      await recorder.run({ tool: "read", input: { path: "b.ts" }, cwd: "/workspace" }, async () => ({
        content: [{ type: "text", text: "third call" }],
      }));

      const retained = store.readRecent(10);
      assert.equal(retained.length, 2);
      assert.deepEqual(retained.map((call) => call.tool), ["read", "edit"]);
      assert.equal((await store.readCall(first.id)).kind, "not_found");
      assert.equal(await countPayloadFiles(dir), 2);
      await access(join(dir, "history.db"));
    });
  });
});

test("concurrent invocations keep independent client identity through live and retained success/error", async () => {
  await withToolHistory(10, async ({ recorder, store, tracker }) => {
    const opened = tracker.openFeed();
    const one = withToolLogContext({ clientName: "client-one", clientSessionId: "openai:one" }, () =>
      recorder.run({ tool: "first", input: {}, cwd: "/one" }, async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        return { ok: true };
      }));
    const two = withToolLogContext({ clientName: "client-two", clientSessionId: "openai:two" }, () =>
      recorder.run({ tool: "second", input: {}, cwd: "/two" }, async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        throw new Error("expected tool error");
      }));

    const results = await Promise.allSettled([one, two]);
    assert.equal(results[0]?.status, "fulfilled");
    assert.equal(results[1]?.status, "rejected");

    const events = await Promise.all(Array.from({ length: 4 }, () => opened.feed.next()));
    opened.feed.close();
    for (const [tool, name, session] of [
      ["first", "client-one", "openai:one"],
      ["second", "client-two", "openai:two"],
    ]) {
      assert.deepEqual(events.filter((event) => event?.call.tool === tool).map((event) => [
        event?.call.clientName, event?.call.clientSessionId,
      ]), [
        [name, session], [name, session],
      ]);
      const stored = store.readRecent(10).find((call) => call.tool === tool)!;
      assert.equal(stored.clientName, name);
      assert.equal(stored.clientSessionId, session);
      const payload = await store.readCall(stored.id);
      assert.equal(payload.kind, "found");
      if (payload.kind === "found") {
        assert.equal(payload.record.client_name, name);
        assert.equal(payload.record.client_session_id, session);
      }
    }
  });
});

test("retention keeps newest calls by invocation start order when completion is out of order", async () => {
  await withToolHistory(1, async ({ dir, store, recorder }) => {
    let releaseSlow!: () => void;
    const slow = recorder.run({ tool: "slow", input: {} }, () => new Promise<void>((resolve) => {
      releaseSlow = resolve;
    }));

    await recorder.run({ tool: "fast", input: {} }, async () => ({ ok: true }));
    releaseSlow();
    await slow;

    const retained = store.readRecent(10);
    assert.equal(retained.length, 1);
    assert.equal(retained[0]!.tool, "fast");
    assert.equal(await countPayloadFiles(dir), 1);
  });
});

test("concurrent completions preserve the exact retention limit", async () => {
  await withToolHistory(5, async ({ dir, store, recorder }) => {
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        recorder.run({ tool: "concurrent", input: { i }, shellId: 7, cwd: "/workspace" }, async () => ({ i }))),
    );

    const retained = store.readRecent(100);
    assert.equal(retained.length, 5);
    assert.equal(new Set(retained.map((call) => call.id)).size, 5);
    assert.equal(await countPayloadFiles(dir), 5);
  });
});

test("history survives restart with input previews and durable cursor pagination", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-tool-history-reopen-"));
  let tracker = new ActivityTracker(10);
  let store = new ObservabilityStore(dir, 10);
  await store.initialize();
  let recorder = new ToolCallRecorder(store, tracker);

  try {
    for (let i = 0; i < 5; i++) {
      await recorder.run(
        { tool: "read", input: { path: `file-${i}.ts` }, shellId: 9, cwd: "/workspace" },
        async () => ({ i }),
      );
    }

    store.close();
    tracker.close();

    store = new ObservabilityStore(dir, 10);
    await store.initialize();
    tracker = new ActivityTracker(10);
    recorder = new ToolCallRecorder(store, tracker);

    const recent = store.readRecent(1);
    assert.deepEqual(recent[0]!.inputPreview, { path: "file-4.ts" });

    const first = store.listShellCalls(9, 2);
    const second = store.listShellCalls(9, 2, first.nextCursor);
    const third = store.listShellCalls(9, 2, second.nextCursor);
    const calls = [...first.items, ...second.items, ...third.items];

    assert.equal(calls.length, 5);
    assert.equal(new Set(calls.map((call) => call.id)).size, 5);
    assert.deepEqual(calls.map((call) => call.inputPreview?.path), [
      "file-4.ts",
      "file-3.ts",
      "file-2.ts",
      "file-1.ts",
      "file-0.ts",
    ]);
  } finally {
    tracker.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy gzip payloads migrate once into sharded durable history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-tool-history-legacy-"));
  const callsDir = join(dir, "calls");
  await mkdir(callsDir, { recursive: true });

  const records = [
    legacyRecord("00000000-0000-4000-8000-000000000001", 1, "2026-10-06T23:59:00.000Z", "old.ts"),
    legacyRecord("00000000-0000-4000-8000-000000000002", 2, "2026-10-07T00:01:00.000Z", "new.ts"),
  ];
  for (const record of records) {
    await writeFile(
      join(callsDir, `${record.started_at.replace(/[-:]/g, "")}-${String(record.sequence).padStart(10, "0")}-${record.id}.json.gz`),
      gzipSync(Buffer.from(JSON.stringify(record), "utf8")),
      { mode: 0o600 },
    );
  }
  const legacyTemp =
    ".20261007T000100.000Z-0000000002-00000000-0000-4000-8000-000000000002.json.gz." +
    "00000000-0000-4000-8000-000000000003.tmp";
  await writeFile(join(callsDir, legacyTemp), "orphaned temp", "utf8");
  await writeFile(join(callsDir, "malformed.json.gz"), gzipSync(Buffer.from("{not-json", "utf8")), { mode: 0o600 });
  await writeFile(join(dir, "index.jsonl"), "{legacy metadata}\n", "utf8");

  const store = new ObservabilityStore(dir, 10);
  try {
    await store.initialize();
    assert.equal(store.readRecent(10).length, 2);
    assert.deepEqual(store.readRecent(10)[0]!.inputPreview, { path: "new.ts" });
    assert.equal(store.getShellActivity(11)?.lastEventAt, Date.parse(records[1]!.finished_at));
    assert.equal(await countPayloadFiles(dir), 2);
    await assert.rejects(() => readFile(join(dir, "index.jsonl")));
    await assert.rejects(() => readdir(callsDir));
    const rejected = await readdir(join(dir, "legacy-rejected"));
    assert.equal(rejected.length, 1);
    assert.match(rejected[0]!, /^malformed\.json\.gz\..+\.rejected$/);

    store.close();
    const reopened = new ObservabilityStore(dir, 10);
    try {
      await reopened.initialize();
      assert.equal(reopened.readRecent(10).length, 2);
      assert.equal(reopened.getShellActivity(11)?.lastEventAt, Date.parse(records[1]!.finished_at));
      assert.equal(await countPayloadFiles(dir), 2);
      assert.equal((await readdir(join(dir, "legacy-rejected"))).length, 1);
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("lower retention converges existing durable history on startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-tool-history-prune-"));
  let store = new ObservabilityStore(dir, 5);
  let tracker = new ActivityTracker(5);
  let recorder = new ToolCallRecorder(store, tracker);
  try {
    await store.initialize();
    for (let i = 0; i < 5; i++) {
      await recorder.run({ tool: "read", input: { i } }, async () => ({ i }));
    }
    store.close();
    tracker.close();

    store = new ObservabilityStore(dir, 2);
    tracker = new ActivityTracker(2);
    recorder = new ToolCallRecorder(store, tracker);
    await store.initialize();

    assert.equal(store.readRecent(10).length, 2);
    assert.equal(await countPayloadFiles(dir), 2);
  } finally {
    tracker.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("durable Shell history remains queryable beyond the live activity window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-tool-history-query-"));
  const shells = await ShellStore.open(dir, join(dir, "shells.db"));
  const shell = shells.create("/workspace");
  const otherShell = shells.create("/other-workspace");
  const store = new ObservabilityStore(join(dir, "tool-logs"), 10);
  const tracker = new ActivityTracker(1);
  const recorder = new ToolCallRecorder(store, tracker);
  await store.initialize();

  try {
    for (let i = 0; i < 3; i++) {
      await recorder.run(
        { tool: "read", input: { path: `file-${i}.ts` }, shellId: shell.id, cwd: shell.cwd },
        async () => ({ i }),
      );
    }

    assert.equal(tracker.snapshot().workspaces[0]?.recentCalls.length, 1);

    const query = new ObservabilityQuery(shells, store, tracker);
    const firstPage = query.listShellCalls(shell.id, 1);
    assert.ok(firstPage.next_cursor);
    assert.throws(
      () => query.listShellCalls(otherShell.id, 10, firstPage.next_cursor!),
      /Cursor is malformed/,
    );

    const history = query.listShellCalls(shell.id, 10);
    assert.equal(history.items.length, 3);
    assert.deepEqual(history.items.map((call) => call.input_preview?.path), [
      "file-2.ts",
      "file-1.ts",
      "file-0.ts",
    ]);

    const oldest = history.items[2]!;
    const detail = await query.getToolCall(oldest.id);
    assert.equal((detail.input as { path: string }).path, "file-0.ts");

    const shellsPage = query.listWorkspaceShells(shell.cwd, 10);
    assert.ok(shellsPage.items[0]!.last_activity_at);
  } finally {
    tracker.close();
    store.close();
    shells.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed history initialization stays degraded for the process instead of retrying", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-tool-history-init-failure-"));
  const dbPath = join(dir, "history.db");
  await mkdir(dbPath, { recursive: true });
  const store = new ObservabilityStore(dir, 10);

  try {
    await assert.rejects(() => store.initialize());
    await rm(dbPath, { recursive: true, force: true });

    await assert.rejects(
      () => store.initialize(),
      /EISDIR|directory|open|history/i,
      "the same process must retain the original failed initialization instead of silently retrying",
    );

    const restarted = new ObservabilityStore(dir, 10);
    try {
      await restarted.initialize();
      assert.deepEqual(restarted.readRecent(1), []);
    } finally {
      restarted.close();
    }
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("history persistence failure never replaces tool success or the original tool error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-tool-history-failure-"));
  await mkdir(join(dir, "history.db"), { recursive: true });
  const store = new ObservabilityStore(dir, 10);
  const tracker = new ActivityTracker(10);
  const recorder = new ToolCallRecorder(store, tracker);
  const previousConsoleError = console.error;
  let persistenceErrors = 0;
  console.error = (...args: unknown[]) => {
    if (args[0] === "Failed to persist tool log:") persistenceErrors += 1;
  };

  try {
    assert.deepEqual(
      await recorder.run({ tool: "read", input: {} }, async () => ({ ok: true })),
      { ok: true },
    );
    await assert.rejects(
      () => recorder.run({ tool: "bash", input: {} }, async () => {
        throw new Error("original failure");
      }),
      /original failure/,
    );
    assert.equal(persistenceErrors, 1, "a continuous degraded history store should report once, not once per call");
  } finally {
    console.error = previousConsoleError;
    tracker.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function withToolHistory(
  maxCalls: number,
  callback: (context: {
    dir: string;
    store: ObservabilityStore;
    tracker: ActivityTracker;
    recorder: ToolCallRecorder;
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-tool-history-test-"));
  const store = new ObservabilityStore(dir, maxCalls);
  const tracker = new ActivityTracker(maxCalls);
  const recorder = new ToolCallRecorder(store, tracker);
  await store.initialize();

  try {
    await callback({ dir, store, tracker, recorder });
  } finally {
    tracker.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function legacyRecord(id: string, sequence: number, startedAt: string, path: string): ToolCallRecord {
  return {
    version: 2,
    id,
    sequence,
    shell_id: 11,
    cwd: "/legacy",
    started_at: startedAt,
    finished_at: new Date(Date.parse(startedAt) + 5).toISOString(),
    duration_ms: 5,
    tool: "read",
    input: { path },
    status: "success",
    output: { ok: true },
  };
}

async function countPayloadFiles(logDir: string): Promise<number> {
  const root = join(logDir, "payloads");
  let count = 0;
  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error: any) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".json.gz")) count += 1;
    }
  }
  await visit(root);
  return count;
}
