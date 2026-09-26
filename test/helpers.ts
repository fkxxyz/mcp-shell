import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteAppConfig } from "../src/config.js";
import { AuthStateStore } from "../src/auth/state-store.js";

export function makeConfig(overrides: Partial<RemoteAppConfig["oauth"]> = {}): RemoteAppConfig {
  return {
    mode: "remote",
    port: 0,
    publicBaseUrl: "https://mcp.example.test",
    commandPath: {
      userBinDir: "/unused/user-bin",
      repoBinDir: "/unused/repo-bin",
    },
    oauth: {
      clientId: "chatgpt",
      clientSecret: "client-secret",
      adminPassword: "admin-password",
      redirectUri: "https://client.example.test/callback",
      redirectUriAllowlist: ["prefix:https://chatgpt.com/connector/oauth/"],
      ...overrides,
    },
    paths: {
      configDir: "/unused",
      envFile: "/unused/env",
      shellEnvFile: null,
      stateFile: "/unused/state.json",
      shellsDbFile: "/unused/shells.db",
      userBinDir: "/unused/user-bin",
      repoBinDir: "/unused/repo-bin",
    },
  };
}

export async function makeStore(): Promise<{ store: AuthStateStore; dir: string; stateFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-test-"));
  const stateFile = join(dir, "state.json");
  const store = new AuthStateStore(dir, stateFile);
  await store.load();
  return { store, dir, stateFile };
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
