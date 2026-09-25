import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type EnvMap = Record<string, string>;

export type AppConfig = {
  port: number;
  publicBaseUrl: string;
  oauth: {
    clientId: string;
    clientSecret: string;
    adminPassword: string;
    redirectUri: string;
    redirectUriAllowlist: string[];
  };
  paths: {
    configDir: string;
    envFile: string;
    shellEnvFile: string | null;
    stateFile: string;
  };
};

export async function loadConfig(): Promise<AppConfig> {
  const configDir = join(homedir(), ".mcp-shell");
  const envFile = join(configDir, "env");
  const stateFile = join(configDir, "state.json");

  const serverEnv = await readServerEnvFile(configDir, envFile);
  const shellEnvFile = serverEnv.SHELL_ENV_FILE
    ? resolveConfiguredPath(serverEnv.SHELL_ENV_FILE, configDir)
    : null;

  if (shellEnvFile) {
    const shellEnv = await sourceShellEnvironment(shellEnvFile);
    replaceProcessEnvironment(shellEnv);
  }

  // The MCP server's own configuration is authoritative over the sourced
  // user environment. This prevents unrelated shell variables from changing
  // server behavior (for example PORT or PUBLIC_BASE_URL).
  Object.assign(process.env, serverEnv);

  return {
    port: Number(process.env.PORT ?? 3000),
    publicBaseUrl: mustEnv("PUBLIC_BASE_URL", envFile).replace(/\/+$/, ""),
    oauth: {
      clientId: mustEnv("OAUTH_CLIENT_ID", envFile),
      clientSecret: mustEnv("OAUTH_CLIENT_SECRET", envFile),
      adminPassword: mustEnv("ADMIN_PASSWORD", envFile),
      redirectUri: process.env.OAUTH_REDIRECT_URI ?? "",
      redirectUriAllowlist: (process.env.OAUTH_REDIRECT_URI_ALLOWLIST ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    },
    paths: { configDir, envFile, shellEnvFile, stateFile },
  };
}

async function readServerEnvFile(configDir: string, envFile: string): Promise<EnvMap> {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(configDir, 0o700);

  try {
    return parseEnvFile(await readFile(envFile, "utf8"));
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;

    const template = [
      "# MCP Shell configuration",
      "PUBLIC_BASE_URL=https://mcp.example.com",
      "OAUTH_CLIENT_ID=chatgpt",
      "OAUTH_CLIENT_SECRET=CHANGE_ME",
      "# Optional stable redirect URI for one client:",
      "OAUTH_REDIRECT_URI=",
      "# Comma-separated allowlist. Use exact: or prefix: rules.",
      "# Example for ChatGPT dynamic callbacks:",
      "OAUTH_REDIRECT_URI_ALLOWLIST=prefix:https://chatgpt.com/connector/oauth/",
      "ADMIN_PASSWORD=CHANGE_ME",
      "PORT=3000",
      "# Tool call history. Payloads are gzip-compressed and the oldest calls are removed by count.",
      "TOOL_LOG_DIR=",
      "TOOL_LOG_MAX_CALLS=10000",
      "# Optional shell file to source at startup for PATH and other user environment variables:",
      "SHELL_ENV_FILE=~/.shellenv",
      "",
    ].join("\n");

    await writeFile(envFile, template, { mode: 0o600 });
    await chmod(envFile, 0o600);

    throw new Error(`Created config template at ${envFile}. Edit it, then start the server again.`);
  }
}

export function parseEnvFile(raw: string): EnvMap {
  const env: EnvMap = {};

  for (const originalLine of raw.split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

export function resolveConfiguredPath(path: string, configDir: string): string {
  const expanded = path === "~"
    ? homedir()
    : path.startsWith("~/")
      ? join(homedir(), path.slice(2))
      : path;

  return isAbsolute(expanded) ? expanded : resolve(configDir, expanded);
}

export async function sourceShellEnvironment(shellEnvFile: string): Promise<EnvMap> {
  try {
    const { stdout } = await execFileAsync(
      "/bin/bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        'set -a; source "$1" >&2 || exit $?; env -0',
        "mcp-shell-env",
        shellEnvFile,
      ],
      {
        env: process.env,
        encoding: "buffer",
        maxBuffer: 4 * 1024 * 1024,
      },
    );

    return parseNullSeparatedEnvironment(stdout as Buffer);
  } catch (error: any) {
    const detail = Buffer.isBuffer(error?.stderr)
      ? error.stderr.toString("utf8").trim()
      : typeof error?.stderr === "string"
        ? error.stderr.trim()
        : "";
    const suffix = detail ? `: ${detail}` : "";
    throw new Error(`Failed to load shell environment from ${shellEnvFile}${suffix}`, { cause: error });
  }
}

export function parseNullSeparatedEnvironment(raw: Buffer): EnvMap {
  const env: EnvMap = {};

  for (const entry of raw.toString("utf8").split("\0")) {
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }

  return env;
}

function replaceProcessEnvironment(env: EnvMap): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in env)) delete process.env[key];
  }
  Object.assign(process.env, env);
}

function mustEnv(name: string, envFile: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required configuration: ${name}`);
  if (value === "CHANGE_ME") {
    throw new Error(`Configuration ${name} is still CHANGE_ME in ${envFile}`);
  }
  return value;
}
