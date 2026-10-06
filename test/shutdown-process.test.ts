import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

test("SIGTERM lets an active tool finish normally inside the three-second grace window", {
  skip: process.platform === "win32",
}, async (t) => {
  const fixture = await startProcessFixture(t);
  const naturalCall = fixture.client.callTool({
    name: "bash",
    arguments: {
      shell_id: fixture.shellId,
      command: "printf ready > natural.ready; sleep 0.25; printf done",
    },
  });
  await waitForFile(join(fixture.project, "natural.ready"), 3_000);

  const signalAt = Date.now();
  assert.equal(fixture.child.kill("SIGTERM"), true);
  await waitUntil(
    () => fixture.output().includes("Shutdown started: signal=SIGTERM") ? true : undefined,
    2_000,
  );

  const result = await naturalCall;
  assert.equal(result.isError, undefined);
  assert.match(toolText(result), /done/);
  await waitForExit(fixture.child, 3_000);
  const elapsed = Date.now() - signalAt;
  assert.ok(elapsed < 1_500, `shutdown waited unnecessarily for the full grace window: ${elapsed}ms`);
  assert.doesNotMatch(fixture.output(), /Shutdown tool grace period expired/);
  assert.match(fixture.output(), /Shutdown completed: duration=/);
});

test("SIGTERM interrupts overdue tools, rejects new work, and exits cleanly", {
  skip: process.platform === "win32",
}, async (t) => {
  const fixture = await startProcessFixture(t);
  const longCall = fixture.client.callTool({
    name: "bash",
    arguments: {
      shell_id: fixture.shellId,
      command: "printf ready > bash.ready; trap 'printf term > bash.term; exit 0' TERM; while :; do sleep 0.2; done",
    },
  });
  await waitForFile(join(fixture.project, "bash.ready"), 3_000);

  const signalAt = Date.now();
  assert.equal(fixture.child.kill("SIGTERM"), true);
  await waitUntil(
    () => fixture.output().includes("Shutdown started: signal=SIGTERM") ? true : undefined,
    2_000,
  );

  const lateCall = fixture.client.callTool({
    name: "bash",
    arguments: { shell_id: fixture.shellId, command: "touch late.started" },
  }).catch(() => undefined);

  const result = await longCall;
  assert.equal(result.isError, true);
  assert.match(toolText(result), /Tool invocation interrupted by server shutdown/);

  await waitForExit(fixture.child, 6_000);
  const elapsed = Date.now() - signalAt;
  assert.ok(elapsed >= 2_800, `shutdown completed too early: ${elapsed}ms`);
  assert.ok(elapsed < 6_000, `shutdown did not converge promptly: ${elapsed}ms`);

  const termDelay = (await stat(join(fixture.project, "bash.term"))).mtimeMs - signalAt;
  assert.ok(termDelay >= 2_800, `bash received TERM before the grace window elapsed: ${termDelay}ms`);
  assert.equal(await exists(join(fixture.project, "late.started")), false, "new work started after shutdown admission closed");
  assert.match(fixture.output(), /Shutdown tool grace period expired/);
  assert.match(fixture.output(), /interrupting 1 cancellable invocation/);
  assert.match(fixture.output(), /Shutdown completed: duration=/);
  assert.doesNotMatch(fixture.output(), /statement has been finalized/);

  await lateCall;
});

type ProcessFixture = {
  child: ChildProcess;
  client: Client;
  project: string;
  shellId: number;
  output(): string;
};

async function startProcessFixture(t: TestContext): Promise<ProcessFixture> {
  const home = await mkdtemp(join(tmpdir(), "mcp-shell-shutdown-test-"));
  const configDir = join(home, ".mcp-shell");
  const project = join(home, "project");
  await mkdir(configDir, { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(configDir, "env"), [
    "MODE=local",
    "PORT=0",
    "TOOL_LOG_MAX_CALLS=100",
    "WEB_PASSWORD=",
    "SHELL_ENV_FILE=",
    "",
  ].join("\n"));

  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "mcp-shell.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      MCP_SHELL_DEV_ANNOUNCE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { output += chunk; });
  child.stderr?.on("data", (chunk: string) => { output += chunk; });

  const originMatch = await waitUntil(
    () => output.match(/MCP_SHELL_DEV_ORIGIN=(http:\/\/127\.0\.0\.1:\d+)/) ?? undefined,
    5_000,
  );
  const client = new Client({ name: "shutdown-process-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${originMatch[1]!}/mcp`));
  await client.connect(transport);

  const created = await client.callTool({ name: "create_shell", arguments: { cwd: project } });
  const shellId = (created.structuredContent as { shell_id?: unknown } | undefined)?.shell_id;
  if (typeof shellId !== "number") throw new Error("create_shell did not return a numeric shell_id");

  t.after(async () => {
    await client.close().catch(() => {});
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child, 2_000).catch(() => {});
    }
    await rm(home, { recursive: true, force: true });
  });

  return {
    child,
    client,
    project,
    shellId,
    output: () => output,
  };
}

function toolText(result: unknown): string {
  if (typeof result !== "object" || result === null || !("content" in result)) return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: "text"; text: string } =>
      typeof item === "object" && item !== null && (item as any).type === "text" && typeof (item as any).text === "string"
    )
    .map((item) => item.text)
    .join("\n");
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  await waitUntil(async () => await exists(path) ? true : undefined, timeoutMs);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil<T>(probe: () => T | undefined | Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`Child process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve();
    };
    child.once("exit", onExit);
  });
}
