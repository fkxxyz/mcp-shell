import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { LocalAppConfig } from "../src/config.js";
import { createApp } from "../src/http/app.js";
import { ShellStore } from "../src/shell-store.js";
import { createShell } from "../src/shell.js";
import { SkillCatalog } from "../src/skills.js";

function emptySkillCatalog(dir: string): SkillCatalog {
  return new SkillCatalog({ root: join(dir, "skills"), onDiagnostic: () => {} });
}

test("shell IDs persist and increase across store reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-store-test-"));
  const project = join(dir, "project");
  const dbFile = join(dir, "shells.db");
  await mkdir(project);

  try {
    let store = await ShellStore.open(dir, dbFile);
    const first = store.create(project);
    const second = store.create(project);
    assert.ok(second.id > first.id);
    store.close();

    store = await ShellStore.open(dir, dbFile);
    assert.equal(store.require(first.id).cwd, project);
    const third = store.create(project);
    assert.ok(third.id > second.id);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createShell returns concise bootstrap instructions without AGENTS.md", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-bootstrap-test-"));
  const project = join(dir, "project");
  await mkdir(project);
  const store = await ShellStore.open(dir, join(dir, "shells.db"));

  try {
    const result = await createShell(store, project, { globalAgentsPath: null, skillCatalog: emptySkillCatalog(dir) });
    assert.equal(
      result.instructions,
      `Shell ${result.shellId} is rooted at ${project}.\n\nKeep using shell ID ${result.shellId} for all subsequent operations while working in this directory.\nDo not call create_shell again unless the required working directory changes.\nTell the user that the shell ID for this session is ${result.shellId}.\n\nPrefer relative paths.`,
    );
    assert.equal(store.require(result.shellId).cwd, project);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("createShell appends root AGENTS.md to bootstrap instructions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-agents-test-"));
  const project = join(dir, "project");
  await mkdir(project);
  await writeFile(join(project, "AGENTS.md"), "# Repository rules\n\nRun tests.\n", "utf8");
  const store = await ShellStore.open(dir, join(dir, "shells.db"));

  try {
    const result = await createShell(store, project, { globalAgentsPath: null, skillCatalog: emptySkillCatalog(dir) });
    assert.equal(
      result.instructions,
      `Shell ${result.shellId} is rooted at ${project}.\n\nKeep using shell ID ${result.shellId} for all subsequent operations while working in this directory.\nDo not call create_shell again unless the required working directory changes.\nTell the user that the shell ID for this session is ${result.shellId}.\n\nPrefer relative paths.\n\nProject instructions from AGENTS.md:\n\n# Repository rules\n\nRun tests.`,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("createShell returns global AGENTS.md before project AGENTS.md", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-global-agents-test-"));
  const project = join(dir, "project");
  const globalDir = join(dir, ".agents");
  const globalAgentsPath = join(globalDir, "AGENTS.md");
  await mkdir(project);
  await mkdir(globalDir);
  await writeFile(globalAgentsPath, "# Global rules\n\nGlobal first.\n", "utf8");
  await writeFile(join(project, "AGENTS.md"), "# Repository rules\n\nProject second.\n", "utf8");
  const store = await ShellStore.open(dir, join(dir, "shells.db"));

  try {
    const result = await createShell(store, project, { globalAgentsPath, skillCatalog: emptySkillCatalog(dir) });
    assert.equal(
      result.instructions,
      `Shell ${result.shellId} is rooted at ${project}.\n\nKeep using shell ID ${result.shellId} for all subsequent operations while working in this directory.\nDo not call create_shell again unless the required working directory changes.\nTell the user that the shell ID for this session is ${result.shellId}.\n\nPrefer relative paths.\n\nGlobal instructions from ~/.agents/AGENTS.md:\n\n# Global rules\n\nGlobal first.\n\nProject instructions from AGENTS.md:\n\n# Repository rules\n\nProject second.`,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("createShell rejects invalid roots before allocating a shell", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-invalid-test-"));
  const project = join(dir, "project");
  await mkdir(project);
  const store = await ShellStore.open(dir, join(dir, "shells.db"));

  try {
    const skillCatalog = emptySkillCatalog(dir);
    await assert.rejects(() => createShell(store, "relative/path", { globalAgentsPath: null, skillCatalog }), /cwd must be an absolute path/);
    await assert.rejects(() => createShell(store, join(dir, "missing"), { globalAgentsPath: null, skillCatalog }), /Cannot access shell cwd/);
    const first = await createShell(store, project, { globalAgentsPath: null, skillCatalog });
    assert.equal(first.shellId, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("createShell rejects a non-file AGENTS.md before allocation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-agents-type-test-"));
  const project = join(dir, "project");
  await mkdir(project);
  await mkdir(join(project, "AGENTS.md"));
  const store = await ShellStore.open(dir, join(dir, "shells.db"));

  try {
    const skillCatalog = emptySkillCatalog(dir);
    await assert.rejects(() => createShell(store, project, { globalAgentsPath: null, skillCatalog }), /AGENTS\.md is not a file/);
    await rm(join(project, "AGENTS.md"), { recursive: true });
    const first = await createShell(store, project, { globalAgentsPath: null, skillCatalog });
    assert.equal(first.shellId, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("createShell lists skill summaries without loading skill instructions into bootstrap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-skills-bootstrap-test-"));
  const project = join(dir, "project");
  const skillsRoot = join(dir, "skills");
  const skillDir = join(skillsRoot, "nested", "writer");
  await mkdir(project);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    "---\nname: writer\ndescription: |\n  Write polished text\n  from rough notes.\n---\nSECRET_SKILL_BODY\n",
    "utf8",
  );
  const store = await ShellStore.open(dir, join(dir, "shells.db"));
  const skillCatalog = new SkillCatalog({ root: skillsRoot, onDiagnostic: () => {} });

  try {
    const result = await createShell(store, project, { globalAgentsPath: null, skillCatalog });
    assert.deepEqual(result.skills, [{ name: "writer", description: "Write polished text\nfrom rough notes.\n" }]);
    assert.match(result.instructions, /Available skills:\n- writer: Write polished text from rough notes\./);
    assert.match(result.instructions, /Use the skill tool with an exact skill name/);
    assert.doesNotMatch(result.instructions, /SECRET_SKILL_BODY/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("MCP create_shell feeds shell_id into relative file operations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-mcp-test-"));
  const project = join(dir, "project");
  await mkdir(project);
  await writeFile(join(project, "hello.txt"), "hello from shell\n", "utf8");

  const config: LocalAppConfig = {
    mode: "local",
    port: 0,
    commandPath: {
      userBinDir: join(dir, "user-bin"),
      repoBinDir: join(dir, "repo-bin"),
    },
    toolLogs: {
      dir: join(dir, "tool-logs"),
      maxCalls: 10_000,
    },
    paths: {
      configDir: dir,
      envFile: join(dir, "env"),
      shellEnvFile: null,
      stateFile: join(dir, "state.json"),
      shellsDbFile: join(dir, "shells.db"),
      userBinDir: join(dir, "user-bin"),
      repoBinDir: join(dir, "repo-bin"),
    },
  };

  const runtime = await createApp(config, { skills: emptySkillCatalog(dir) });
  const server = await new Promise<Server>((resolve) => {
    const listening = runtime.app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address() as AddressInfo;
  const client = new Client({ name: "shell-integration-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));

  try {
    await client.connect(transport);
    const created = await client.callTool({ name: "create_shell", arguments: { cwd: project } });
    const shellId = (created.structuredContent as { shell_id?: unknown } | undefined)?.shell_id;
    assert.equal(typeof shellId, "number");

    const read = await client.callTool({
      name: "read",
      arguments: { shell_id: shellId, path: "hello.txt" },
    });
    const content = read.content as Array<{ type: string; text?: string }>;
    const text = content
      .filter((item) => item.type === "text")
      .map((item) => item.text ?? "")
      .join("\n");
    assert.match(text, /hello from shell/);

    await client.callTool({
      name: "write",
      arguments: { shell_id: shellId, path: "nested/generated.txt", content: "alpha\nbeta\n" },
    });
    assert.equal(await readFile(join(project, "nested/generated.txt"), "utf8"), "alpha\nbeta\n");

    await client.callTool({
      name: "edit",
      arguments: {
        shell_id: shellId,
        path: "nested/generated.txt",
        edits: [{ oldText: "beta", newText: "gamma" }],
      },
    });
    assert.equal(await readFile(join(project, "nested/generated.txt"), "utf8"), "alpha\ngamma\n");

    const bash = await client.callTool({
      name: "bash",
      arguments: { shell_id: shellId, command: "pwd; cat nested/generated.txt" },
    });
    const bashText = (bash.content as Array<{ type: string; text?: string }>)
      .filter((item) => item.type === "text")
      .map((item) => item.text ?? "")
      .join("\n");
    assert.ok(bashText.includes(project));
    assert.match(bashText, /alpha\ngamma/);
  } finally {
    await client.close().catch(() => {});
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
