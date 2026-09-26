import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ShellStore } from "./shell-store.js";

export type CreateShellResult = {
  shellId: number;
  instructions: string;
};

export async function createShell(store: ShellStore, cwdInput: string): Promise<CreateShellResult> {
  if (!isAbsolute(cwdInput)) throw new Error("cwd must be an absolute path");

  const cwd = resolve(cwdInput);
  let cwdStat;
  try {
    cwdStat = await stat(cwd);
    await access(cwd, constants.R_OK | constants.X_OK);
  } catch (error) {
    throw new Error(`Cannot access shell cwd: ${cwd}`, { cause: error });
  }
  if (!cwdStat.isDirectory()) throw new Error(`Shell cwd is not a directory: ${cwd}`);

  const agentsPath = join(cwd, "AGENTS.md");
  let agentsMd: string | null = null;
  try {
    const agentsStat = await stat(agentsPath);
    if (!agentsStat.isFile()) throw new Error(`AGENTS.md is not a file: ${agentsPath}`);
    agentsMd = await readFile(agentsPath, "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  const shell = store.create(cwd);
  const base = `Shell ${shell.id} is rooted at ${cwd}.\nUse this shell for subsequent operations and prefer relative paths.`;
  const project = agentsMd === null
    ? ""
    : `\n\nProject instructions from AGENTS.md:\n\n${agentsMd.trimEnd()}`;

  return {
    shellId: shell.id,
    instructions: base + project,
  };
}
