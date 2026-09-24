import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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
    stateFile: string;
  };
};

export async function loadConfig(): Promise<AppConfig> {
  const configDir = join(homedir(), ".mcp-shell");
  const envFile = join(configDir, "env");
  const stateFile = join(configDir, "state.json");

  await loadEnvFile(configDir, envFile);

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
    paths: { configDir, envFile, stateFile },
  };
}

async function loadEnvFile(configDir: string, envFile: string): Promise<void> {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(configDir, 0o700);

  try {
    const raw = await readFile(envFile, "utf8");

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

      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
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
      "",
    ].join("\n");

    await writeFile(envFile, template, { mode: 0o600 });
    await chmod(envFile, 0o600);

    throw new Error(`Created config template at ${envFile}. Edit it, then start the server again.`);
  }
}

function mustEnv(name: string, envFile: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required configuration: ${name}`);
  if (value === "CHANGE_ME") {
    throw new Error(`Configuration ${name} is still CHANGE_ME in ${envFile}`);
  }
  return value;
}
