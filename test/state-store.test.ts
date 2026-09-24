import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import test from "node:test";
import { AuthStateStore } from "../src/auth/state-store.js";
import { makeStore } from "./helpers.js";

test("AuthStateStore persists and reloads all token classes", async (t) => {
  const { store, dir, stateFile } = await makeStore();
  t.after(async () => {
    await store.persist();
    await rm(dir, { recursive: true, force: true });
  });

  store.setAuthorizationCode("code", {
    clientId: "client",
    redirectUri: "https://client/callback",
    codeChallenge: "challenge",
    resource: "https://resource",
    expiresAt: Date.now() + 60_000,
  });
  store.setAccessToken("access", { resource: "https://resource", expiresAt: Date.now() + 60_000 });
  store.setRefreshToken("refresh", { resource: "https://resource" });
  await store.persist();

  const reloaded = new AuthStateStore(dir, stateFile);
  await reloaded.load();

  assert.equal(reloaded.getAuthorizationCode("code")?.clientId, "client");
  assert.equal(reloaded.getAccessToken("access")?.resource, "https://resource");
  assert.equal(reloaded.getRefreshToken("refresh")?.resource, "https://resource");

  const mode = (await stat(stateFile)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("consume methods are one-shot", async (t) => {
  const { store, dir } = await makeStore();
  t.after(async () => {
    await store.persist();
    await rm(dir, { recursive: true, force: true });
  });

  store.setAuthorizationCode("code", {
    clientId: "client",
    redirectUri: "https://client/callback",
    codeChallenge: "challenge",
    resource: "https://resource",
    expiresAt: Date.now() + 60_000,
  });
  store.setRefreshToken("refresh", { resource: "https://resource" });

  assert.ok(store.consumeAuthorizationCode("code"));
  assert.equal(store.consumeAuthorizationCode("code"), undefined);
  assert.ok(store.consumeRefreshToken("refresh"));
  assert.equal(store.consumeRefreshToken("refresh"), undefined);
});

test("cleanupExpired removes expired codes and access tokens but leaves live values", async (t) => {
  const { store, dir } = await makeStore();
  t.after(async () => {
    await store.persist();
    await rm(dir, { recursive: true, force: true });
  });

  store.setAuthorizationCode("expired-code", {
    clientId: "client",
    redirectUri: "https://client/callback",
    codeChallenge: "challenge",
    resource: "https://resource",
    expiresAt: Date.now() - 1,
  });
  store.setAuthorizationCode("live-code", {
    clientId: "client",
    redirectUri: "https://client/callback",
    codeChallenge: "challenge",
    resource: "https://resource",
    expiresAt: Date.now() + 60_000,
  });
  store.setAccessToken("expired-access", { resource: "https://resource", expiresAt: Date.now() - 1 });
  store.setAccessToken("live-access", { resource: "https://resource", expiresAt: Date.now() + 60_000 });

  assert.equal(store.cleanupExpired(), true);
  assert.equal(store.getAuthorizationCode("expired-code"), undefined);
  assert.ok(store.getAuthorizationCode("live-code"));
  assert.equal(store.getAccessToken("expired-access"), undefined);
  assert.ok(store.getAccessToken("live-access"));
});

test("load creates an empty state file when none exists", async (t) => {
  const { store, dir, stateFile } = await makeStore();
  t.after(async () => {
    await store.persist();
    await rm(dir, { recursive: true, force: true });
  });

  await store.persist();
  const parsed = JSON.parse(await readFile(stateFile, "utf8"));
  assert.deepEqual(parsed.authorizationCodes, []);
  assert.deepEqual(parsed.accessTokens, []);
  assert.deepEqual(parsed.refreshTokens, []);
});
