import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ShellStore } from "./shell-store.js";

export type CreateShellResult = {
  shellId: number;
  instructions: string;
};

type CreateShellOptions = {
  globalAgentsPath?: string | null;
};

async function readAgentsFile(path: string): Promise<string | null> {
  try {
    const agentsStat = await stat(path);
    if (!agentsStat.isFile()) throw new Error(`AGENTS.md is not a file: ${path}`);
    return await readFile(path, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function createShell(
  store: ShellStore,
  cwdInput: string,
  options: CreateShellOptions = {},
): Promise<CreateShellResult> {
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

  const globalAgentsPath = options.globalAgentsPath === undefined
    ? join(homedir(), ".agents", "AGENTS.md")
    : options.globalAgentsPath;
  const projectAgentsPath = join(cwd, "AGENTS.md");
  const globalAgentsMd = globalAgentsPath === null
    ? null
    : await readAgentsFile(globalAgentsPath);
  const projectAgentsMd = globalAgentsPath !== null && resolve(globalAgentsPath) === projectAgentsPath
    ? null
    : await readAgentsFile(projectAgentsPath);

  const shell = store.create(cwd);
  const base = `Shell ${shell.id} is rooted at ${cwd}.\n\nKeep using shell ID ${shell.id} for all subsequent operations while working in this directory.\nDo not call create_shell again unless the required working directory changes.\nTell the user that the shell ID for this session is ${shell.id}.\n\nPrefer relative paths.`;
  const global = globalAgentsMd === null
    ? ""
    : `\n\nGlobal instructions from ~/.agents/AGENTS.md:\n\n${globalAgentsMd.trimEnd()}`;
  const project = projectAgentsMd === null
    ? ""
    : `\n\nProject instructions from AGENTS.md:\n\n${projectAgentsMd.trimEnd()}`;

  return {
    shellId: shell.id,
    instructions: base + global + project,
  };
}
