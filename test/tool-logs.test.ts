import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { recordToolCall, withToolLogContext } from "../src/tool-logs.js";

test("tool logs preserve complete calls and retain payloads by call count", async () => {
  await withToolLogEnv(2, async (dir) => {
    await withToolLogContext({ session: "session-1", actor: "actor-1" }, async () => {
      const input = { command: "printf hello", nested: { value: "complete input" } };
      const output = { content: [{ type: "text", text: "complete output" }] };

      assert.deepEqual(
        await recordToolCall("bash", input, async () => output),
        output,
      );

      const firstIndex = await readIndex(dir);
      assert.equal(firstIndex.length, 1);
      assert.equal(firstIndex[0].tool, "bash");
      assert.equal(firstIndex[0].session, "session-1");
      assert.equal(firstIndex[0].actor, "actor-1");
      assert.equal(firstIndex[0].status, "success");

      const firstPayloadPath = join(dir, firstIndex[0].file);
      const firstPayload = JSON.parse(gunzipSync(await readFile(firstPayloadPath)).toString("utf8"));
      assert.deepEqual(firstPayload.input, input);
      assert.deepEqual(firstPayload.output, output);

      await assert.rejects(
        () => recordToolCall("edit", { path: "a.ts" }, async () => {
          throw new Error("edit failed");
        }),
        /edit failed/,
      );

      await recordToolCall("read", { path: "b.ts" }, async () => ({
        content: [{ type: "text", text: "third call" }],
      }));

      const index = await readIndex(dir);
      assert.equal(index.length, 3, "metadata history remains append-only");

      const payloadFiles = (await readdir(join(dir, "calls")))
        .filter((name) => name.endsWith(".json.gz"))
        .sort();
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
  await withToolLogEnv(2, async (dir) => {
    const callsDir = join(dir, "calls");
    await mkdir(callsDir, { recursive: true });
    await writeFile(join(callsDir, "20000101T000000.000Z-0000000001-old.json.gz"), "old");
    await writeFile(join(callsDir, "20010101T000000.000Z-0000000002-middle.json.gz"), "middle");
    await writeFile(join(callsDir, "20020101T000000.000Z-0000000003-new.json.gz"), "new");

    await recordToolCall("read", { path: "current.txt" }, async () => ({ ok: true }));

    const payloadFiles = await readPayloadFiles(dir);
    assert.equal(payloadFiles.length, 2);
    assert.equal(payloadFiles.includes("20000101T000000.000Z-0000000001-old.json.gz"), false);
    assert.equal(payloadFiles.includes("20010101T000000.000Z-0000000002-middle.json.gz"), false);
    assert.equal(payloadFiles.includes("20020101T000000.000Z-0000000003-new.json.gz"), true);
  });
});

test("tool log retention does not rescan the payload directory during steady-state writes", async () => {
  await withToolLogEnv(2, async (dir) => {
    await recordToolCall("first", {}, async () => ({ ok: true }));

    const external = "19990101T000000.000Z-0000000001-external.json.gz";
    await writeFile(join(dir, "calls", external), "external");

    await recordToolCall("second", {}, async () => ({ ok: true }));

    const payloadFiles = await readPayloadFiles(dir);
    assert.equal(payloadFiles.length, 3);
    assert.equal(payloadFiles.includes(external), true);
  });
});

test("tool log retention keeps the newest call by start order when calls finish out of order", async () => {
  await withToolLogEnv(1, async (dir) => {
    let releaseSlow!: () => void;
    const slow = recordToolCall("slow", {}, () => new Promise<void>((resolve) => {
      releaseSlow = resolve;
    }));

    await recordToolCall("fast", {}, async () => ({ ok: true }));
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
  await withToolLogEnv(5, async (dir) => {
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        recordToolCall("concurrent", { i }, async () => ({ i }))),
    );

    const payloadFiles = await readPayloadFiles(dir);
    assert.equal(payloadFiles.length, 5);
    assert.equal(new Set(payloadFiles).size, 5);
    assert.equal((await readIndex(dir)).length, 30);
  });
});

test("tool log retention still governs a payload when index persistence fails", async () => {
  await withToolLogEnv(1, async (dir) => {
    const callsDir = join(dir, "calls");
    await mkdir(callsDir, { recursive: true });
    const oldPayload = "20000101T000000.000Z-0000000001-old.json.gz";
    await writeFile(join(callsDir, oldPayload), "old");
    await mkdir(join(dir, "index.jsonl"));

    const previousConsoleError = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(
        await recordToolCall("read", { path: "current.txt" }, async () => ({ ok: true })),
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

test("tool log retention removes orphaned tool-log temp files during initialization", async () => {
  await withToolLogEnv(2, async (dir) => {
    const callsDir = join(dir, "calls");
    await mkdir(callsDir, { recursive: true });
    const orphan =
      ".20000101T000000.000Z-0000000001-00000000-0000-4000-8000-000000000000.json.gz." +
      "00000000-0000-4000-8000-000000000001.tmp";
    const unrelated = "unrelated.tmp";
    await writeFile(join(callsDir, orphan), "orphan");
    await writeFile(join(callsDir, unrelated), "unrelated");

    await recordToolCall("read", {}, async () => ({ ok: true }));

    const entries = await readdir(callsDir);
    assert.equal(entries.includes(orphan), false);
    assert.equal(entries.includes(unrelated), true);
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

async function withToolLogEnv(
  maxCalls: number,
  callback: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-tool-logs-test-"));
  const previousDir = process.env.TOOL_LOG_DIR;
  const previousMaxCalls = process.env.TOOL_LOG_MAX_CALLS;
  process.env.TOOL_LOG_DIR = dir;
  process.env.TOOL_LOG_MAX_CALLS = String(maxCalls);

  try {
    await callback(dir);
  } finally {
    if (previousDir === undefined) delete process.env.TOOL_LOG_DIR;
    else process.env.TOOL_LOG_DIR = previousDir;
    if (previousMaxCalls === undefined) delete process.env.TOOL_LOG_MAX_CALLS;
    else process.env.TOOL_LOG_MAX_CALLS = previousMaxCalls;
    await rm(dir, { recursive: true, force: true });
  }
}
