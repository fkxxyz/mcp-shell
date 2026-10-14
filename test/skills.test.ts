import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { LocalAppConfig } from "../src/config.js";
import { createApp } from "../src/http/app.js";
import { SkillCatalog, type SkillDiagnostic } from "../src/skills.js";

function skillDocument(name: string, description: string, body: string): string {
  return `---
name: ${JSON.stringify(name)}
description: ${JSON.stringify(description)}
---
${body}
`;
}

test("SkillCatalog recursively discovers valid skills and deterministically lets the last valid duplicate win", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-skill-catalog-test-"));
  const root = join(dir, "skills");
  const diagnostics: SkillDiagnostic[] = [];
  await mkdir(join(root, "a", "nested"), { recursive: true });
  await mkdir(join(root, "z"), { recursive: true });
  await mkdir(join(root, "zz-invalid"), { recursive: true });
  await writeFile(join(root, "a", "nested", "SKILL.md"), skillDocument("duplicate", "first", "FIRST_BODY"));
  await writeFile(join(root, "z", "SKILL.md"), skillDocument("duplicate", "last", "LAST_BODY"));
  await writeFile(join(root, "SKILL.md"), skillDocument("alpha", "root skill", "ALPHA_BODY"));
  await writeFile(join(root, "zz-invalid", "SKILL.md"), "---\nname: duplicate\n---\nINVALID_BODY\n");

  try {
    const catalog = new SkillCatalog({ root, onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });
    assert.deepEqual(await catalog.discover(), [
      { name: "alpha", description: "root skill" },
      { name: "duplicate", description: "last" },
    ]);

    const duplicate = await catalog.load("duplicate");
    assert.equal(duplicate?.description, "last");
    assert.match(duplicate?.instructions ?? "", /LAST_BODY/);
    assert.equal(
      diagnostics.some((diagnostic) => diagnostic.reason.includes('duplicate skill name "duplicate" replaces earlier skill')),
      true,
    );
    assert.equal(diagnostics.some((diagnostic) => diagnostic.reason.includes("description")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SkillCatalog follows directory and SKILL.md symlinks, preserves the logical skill directory, and terminates cycles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-skill-links-test-"));
  const root = join(dir, "skills");
  const externalDirSkill = join(dir, "external-dir-skill");
  const externalFileSkill = join(dir, "external-file-skill");
  const logicalFileSkill = join(root, "file-link-skill");
  const diagnostics: SkillDiagnostic[] = [];
  await mkdir(root, { recursive: true });
  await mkdir(externalDirSkill, { recursive: true });
  await mkdir(externalFileSkill, { recursive: true });
  await mkdir(logicalFileSkill, { recursive: true });
  await writeFile(join(externalDirSkill, "SKILL.md"), skillDocument("dir-link", "directory symlink", "DIR_BODY"));
  await writeFile(join(externalFileSkill, "SKILL.md"), skillDocument("file-link", "file symlink", "FILE_BODY"));
  await symlink(externalDirSkill, join(root, "dir-link"), "dir");
  await symlink(join(externalFileSkill, "SKILL.md"), join(logicalFileSkill, "SKILL.md"), "file");
  await symlink(root, join(root, "cycle"), "dir");
  await symlink(join(dir, "missing"), join(root, "broken"));

  try {
    const catalog = new SkillCatalog({ root, onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });
    const summaries = await catalog.discover();
    assert.deepEqual(summaries, [
      { name: "dir-link", description: "directory symlink" },
      { name: "file-link", description: "file symlink" },
    ]);

    assert.equal((await catalog.load("dir-link"))?.directory, await realpath(externalDirSkill));
    assert.equal((await catalog.load("file-link"))?.directory, await realpath(logicalFileSkill));
    assert.equal(diagnostics.some((diagnostic) => diagnostic.path.endsWith("/broken")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SkillCatalog rescans on each load and uses exact case-sensitive names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-skill-reload-test-"));
  const root = join(dir, "skills");
  const skillDir = join(root, "live");
  const skillFile = join(skillDir, "SKILL.md");
  await mkdir(skillDir, { recursive: true });
  await writeFile(skillFile, skillDocument("Live", "version one", "BODY_ONE"));

  try {
    const catalog = new SkillCatalog({ root, onDiagnostic: () => {} });
    assert.match((await catalog.load("Live"))?.instructions ?? "", /BODY_ONE/);
    assert.equal(await catalog.load("live"), null);

    await writeFile(skillFile, skillDocument("Live", "version two", "BODY_TWO"));
    const reloaded = await catalog.load("Live");
    assert.equal(reloaded?.description, "version two");
    assert.match(reloaded?.instructions ?? "", /BODY_TWO/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SkillCatalog treats a missing root as an empty catalog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-skill-missing-root-test-"));
  const diagnostics: SkillDiagnostic[] = [];

  try {
    const catalog = new SkillCatalog({
      root: join(dir, "missing"),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    assert.deepEqual(await catalog.discover(), []);
    assert.deepEqual(diagnostics, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SkillCatalog combines global and project skills with project precedence and no cross-project leakage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-skill-scopes-test-"));
  const root = join(dir, "global-skills");
  const projectA = join(dir, "project-a");
  const projectB = join(dir, "project-b");
  const projectASkills = join(projectA, ".agents", "skills");
  const projectBSkills = join(projectB, ".agents", "skills");
  const diagnostics: SkillDiagnostic[] = [];
  await mkdir(join(root, "shared"), { recursive: true });
  await mkdir(join(root, "global-only"));
  await mkdir(join(projectASkills, "shared"), { recursive: true });
  await mkdir(join(projectASkills, "project-only"));
  await mkdir(join(projectBSkills, "shared"), { recursive: true });
  await mkdir(join(projectA, ".claude", "skills", "ignored"), { recursive: true });
  await writeFile(join(root, "shared", "SKILL.md"), skillDocument("shared", "global", "GLOBAL_BODY"));
  await writeFile(join(root, "global-only", "SKILL.md"), skillDocument("global-only", "global skill", "GLOBAL_ONLY_BODY"));
  await writeFile(join(projectASkills, "shared", "SKILL.md"), skillDocument("shared", "project A", "PROJECT_A_BODY"));
  await writeFile(join(projectASkills, "project-only", "SKILL.md"), skillDocument("project-only", "project A only", "PROJECT_ONLY_BODY"));
  await writeFile(join(projectBSkills, "shared", "SKILL.md"), skillDocument("shared", "project B", "PROJECT_B_BODY"));
  await writeFile(join(projectA, ".claude", "skills", "ignored", "SKILL.md"), skillDocument("ignored", "claude only", "IGNORED_BODY"));

  try {
    const catalog = new SkillCatalog({ root, onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });
    assert.deepEqual(await catalog.discover(projectA), [
      { name: "global-only", description: "global skill" },
      { name: "project-only", description: "project A only" },
      { name: "shared", description: "project A" },
    ]);
    assert.deepEqual(await catalog.discover(projectB), [
      { name: "global-only", description: "global skill" },
      { name: "shared", description: "project B" },
    ]);
    assert.deepEqual(await catalog.discover(), [
      { name: "global-only", description: "global skill" },
      { name: "shared", description: "global" },
    ]);
    assert.equal((await catalog.load("shared", projectA))?.directory, await realpath(join(projectASkills, "shared")));
    assert.match((await catalog.load("shared", projectB))?.instructions ?? "", /PROJECT_B_BODY/);
    assert.match((await catalog.load("shared"))?.instructions ?? "", /GLOBAL_BODY/);
    assert.match((await catalog.load("global-only", projectA))?.instructions ?? "", /GLOBAL_ONLY_BODY/);
    assert.equal(await catalog.load("project-only", projectB), null);
    assert.equal(await catalog.load("ignored", projectA), null);
    assert.ok(diagnostics.some((diagnostic) => diagnostic.reason.includes('duplicate skill name "shared"')));

    await writeFile(join(projectASkills, "shared", "SKILL.md"), skillDocument("shared", "updated project A", "UPDATED_BODY"));
    assert.match((await catalog.load("shared", projectA))?.instructions ?? "", /UPDATED_BODY/);
    await writeFile(join(projectASkills, "shared", "SKILL.md"), "---\nname: shared\n---\nINVALID_BODY\n");
    assert.match((await catalog.load("shared", projectA))?.instructions ?? "", /GLOBAL_BODY/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("MCP skill supports project-specific shell_id and legacy global-only loading", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-skill-mcp-test-"));
  const root = join(dir, "skills");
  const skillDir = join(root, "nested", "writer");
  const projectA = join(dir, "project-a");
  const projectB = join(dir, "project-b");
  const projectASkillDir = join(projectA, ".agents", "skills", "writer");
  const projectBSkillDir = join(projectB, ".agents", "skills", "writer");
  const projectAOnlyDir = join(projectA, ".agents", "skills", "project-only");
  await mkdir(skillDir, { recursive: true });
  await mkdir(projectASkillDir, { recursive: true });
  await mkdir(projectBSkillDir, { recursive: true });
  await mkdir(projectAOnlyDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), skillDocument("writer", "Write polished text", "MCP_SKILL_BODY"));
  await writeFile(join(projectASkillDir, "SKILL.md"), skillDocument("writer", "Project A writer", "PROJECT_A_BODY"));
  await writeFile(join(projectBSkillDir, "SKILL.md"), skillDocument("writer", "Project B writer", "PROJECT_B_BODY"));
  await writeFile(join(projectAOnlyDir, "SKILL.md"), skillDocument("project-only", "Project A only", "PROJECT_ONLY_BODY"));

  const config: LocalAppConfig = {
    mode: "local",
    port: 0,
    commandPath: {
      userBinDir: join(dir, "user-bin"),
      repoBinDir: join(dir, "repo-bin"),
    },
    upstreams: { timeoutMs: 60_000, upstreams: [] },
    toolLogs: {
      dir: join(dir, "tool-logs"),
      maxCalls: 100,
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
  const skills = new SkillCatalog({ root, onDiagnostic: () => {} });
  const runtime = await createApp(config, { skills });
  const server = await new Promise<Server>((resolve) => {
    const listening = runtime.app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address() as AddressInfo;
  const client = new Client({ name: "skill-integration-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));

  try {
    await client.connect(transport);
    const loaded = await client.callTool({ name: "skill", arguments: { name: "writer" } });
    const structured = loaded.structuredContent as {
      name?: unknown;
      description?: unknown;
      directory?: unknown;
      instructions?: unknown;
    } | undefined;
    assert.equal(structured?.name, "writer");
    assert.equal(structured?.description, "Write polished text");
    assert.equal(structured?.directory, await realpath(skillDir));
    assert.match(String(structured?.instructions ?? ""), /MCP_SKILL_BODY/);

    const text = (loaded.content as Array<{ type: string; text?: string }>)
      .filter((item) => item.type === "text")
      .map((item) => item.text ?? "")
      .join("\n");
    assert.match(text, /Skill: writer/);
    assert.match(text, /MCP_SKILL_BODY/);

    const createdA = await client.callTool({ name: "create_shell", arguments: { cwd: projectA } });
    const createdB = await client.callTool({ name: "create_shell", arguments: { cwd: projectB } });
    const shellA = (createdA.structuredContent as { shell_id: number }).shell_id;
    const shellB = (createdB.structuredContent as { shell_id: number }).shell_id;
    assert.deepEqual((createdA.structuredContent as { skills: unknown }).skills, [
      { name: "project-only", description: "Project A only" },
      { name: "writer", description: "Project A writer" },
    ]);
    assert.deepEqual((createdB.structuredContent as { skills: unknown }).skills, [
      { name: "writer", description: "Project B writer" },
    ]);
    assert.match((createdA.structuredContent as { instructions: string }).instructions, /skill tool with this shell_id/);

    const loadedA = await client.callTool({ name: "skill", arguments: { name: "writer", shell_id: shellA } });
    const loadedB = await client.callTool({ name: "skill", arguments: { name: "writer", shell_id: shellB } });
    assert.equal((loadedA.structuredContent as { directory: string }).directory, await realpath(projectASkillDir));
    assert.match((loadedA.structuredContent as { instructions: string }).instructions, /PROJECT_A_BODY/);
    assert.match((loadedB.structuredContent as { instructions: string }).instructions, /PROJECT_B_BODY/);

    const projectOnly = await client.callTool({ name: "skill", arguments: { name: "project-only", shell_id: shellA } });
    assert.match((projectOnly.structuredContent as { instructions: string }).instructions, /PROJECT_ONLY_BODY/);
    const notInProjectB = await client.callTool({ name: "skill", arguments: { name: "project-only", shell_id: shellB } });
    assert.equal(notInProjectB.isError, true);
    const withoutShell = await client.callTool({ name: "skill", arguments: { name: "project-only" } });
    assert.equal(withoutShell.isError, true);

    const unknown = await client.callTool({ name: "skill", arguments: { name: "writer", shell_id: 99999 } });
    assert.equal(unknown.isError, true);
    assert.match(JSON.stringify(unknown.content), /Unknown shell_id/);
  } finally {
    await client.close().catch(() => {});
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
