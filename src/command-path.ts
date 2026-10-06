import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export type CommandPathPolicy = {
  userBinDir: string;
  repoBinDir: string;
};

export function applyCommandPath(
  env: NodeJS.ProcessEnv,
  policy: CommandPathPolicy,
): NodeJS.ProcessEnv {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const pinned = [policy.userBinDir, policy.repoBinDir].filter(Boolean);
  const pinnedSet = new Set(pinned);
  const currentEntries = (env[pathKey] ?? "")
    .split(delimiter)
    .filter(Boolean)
    .filter((entry) => !pinnedSet.has(entry));

  return {
    ...env,
    [pathKey]: [...pinned, ...currentEntries].join(delimiter),
  };
}

export function resolveExecutable(
  command: string,
  options: { cwd: string; env: NodeJS.ProcessEnv },
): string | undefined {
  if (!command) return undefined;

  const candidates = executableNames(command, options.env);
  if (command.includes("/") || command.includes("\\")) {
    const base = isAbsolute(command) ? command : resolve(options.cwd, command);
    for (const candidate of executableNames(base, options.env)) {
      if (isExecutableFile(candidate)) return candidate;
    }
    return undefined;
  }

  const pathKey = Object.keys(options.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  for (const base of (options.env[pathKey] ?? "").split(delimiter).filter(Boolean)) {
    for (const candidate of candidates) {
      const path = isAbsolute(base)
        ? join(base, candidate)
        : resolve(options.cwd, base, candidate);
      if (isExecutableFile(path)) return path;
    }
  }

  return undefined;
}

function executableNames(command: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") return [command];

  const pathExtKey = Object.keys(env).find((key) => key.toLowerCase() === "pathext") ?? "PATHEXT";
  const configured = (env[pathExtKey] ?? "").split(";").filter(Boolean);
  const extensions = [...new Set(["", ...configured, ".exe", ".cmd", ".bat", ".ps1"])];
  return extensions.map((extension) => command + extension);
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
