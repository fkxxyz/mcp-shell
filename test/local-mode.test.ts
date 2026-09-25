import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listenHostForMode, type LocalAppConfig, type RemoteAppConfig } from "../src/config.js";
import { createApp } from "../src/http/app.js";
import { makeConfig } from "./helpers.js";

function makeLocalConfig(): LocalAppConfig {
  return {
    mode: "local",
    port: 0,
    workdir: "/unused/workdir",
    commandPath: {
      userBinDir: "/unused/user-bin",
      repoBinDir: "/unused/repo-bin",
    },
    paths: {
      configDir: "/unused",
      envFile: "/unused/env",
      shellEnvFile: null,
      stateFile: "/unused/state.json",
      userBinDir: "/unused/user-bin",
      repoBinDir: "/unused/repo-bin",
    },
  };
}

async function listen(config: LocalAppConfig | RemoteAppConfig) {
  const runtime = await createApp(config);
  const server = await new Promise<Server>((resolve) => {
    const listening = runtime.app.listen(0, listenHostForMode(config.mode), () => resolve(listening));
  });
  const address = server.address() as AddressInfo;
  return {
    runtime,
    server,
    address,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("local mode binds loopback, omits OAuth routes, and serves /mcp without bearer auth", async (t) => {
  const ctx = await listen(makeLocalConfig());
  t.after(async () => {
    await close(ctx.server);
    await ctx.runtime.close();
  });

  assert.equal(ctx.address.address, "127.0.0.1");

  const discovery = await fetch(`${ctx.baseUrl}/.well-known/oauth-protected-resource`);
  assert.equal(discovery.status, 404);

  const mcp = await fetch(`${ctx.baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(mcp.status, 400);
  assert.equal(mcp.headers.get("www-authenticate"), null);
});

test("remote mode keeps all-interface binding and bearer-protected /mcp", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-remote-mode-test-"));
  const base = makeConfig();
  const config: RemoteAppConfig = {
    ...base,
    paths: {
      ...base.paths,
      configDir: dir,
      stateFile: join(dir, "state.json"),
    },
  };
  const ctx = await listen(config);
  t.after(async () => {
    await close(ctx.server);
    await ctx.runtime.close();
    await rm(dir, { recursive: true, force: true });
  });

  assert.equal(ctx.address.address, "0.0.0.0");

  const discovery = await fetch(`${ctx.baseUrl}/.well-known/oauth-protected-resource`);
  assert.equal(discovery.status, 200);

  const mcp = await fetch(`${ctx.baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(mcp.status, 401);
  assert.match(mcp.headers.get("www-authenticate") ?? "", /^Bearer /);
});
