import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

export function resolveHostPath(cwd: string, path: string): string {
  const expanded = expandHomePath(path);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}
