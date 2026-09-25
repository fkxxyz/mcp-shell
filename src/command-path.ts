import { delimiter } from "node:path";

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
