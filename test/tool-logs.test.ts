import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { recordToolCall, withToolLogContext } from "../src/tool-logs.js";

test("tool logs preserve complete calls and retain payloads by call count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-tool-logs-test-"));
  const previousDir = process.env.TOOL_LOG_DIR;
  const previousMaxCalls = process.env.TOOL_LOG_MAX_CALLS;
  process.env.TOOL_LOG_DIR = dir;
  process.env.TOOL_LOG_MAX_CALLS = "2";

  try {
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
  } finally {
    if (previousDir === undefined) delete process.env.TOOL_LOG_DIR;
    else process.env.TOOL_LOG_DIR = previousDir;
    if (previousMaxCalls === undefined) delete process.env.TOOL_LOG_MAX_CALLS;
    else process.env.TOOL_LOG_MAX_CALLS = previousMaxCalls;
    await rm(dir, { recursive: true, force: true });
  }
});

async function readIndex(dir: string): Promise<any[]> {
  const raw = await readFile(join(dir, "index.jsonl"), "utf8");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
