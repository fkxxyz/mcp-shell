import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { OAuthService, type AuthorizeParams } from "../src/auth/oauth-service.js";
import { makeConfig, makeStore, pkceChallenge } from "./helpers.js";

function authorizeParams(verifier = "verifier-value"): AuthorizeParams {
  return {
    responseType: "code",
    clientId: "chatgpt",
    redirectUri: "https://client.example.test/callback",
    codeChallenge: pkceChallenge(verifier),
    codeChallengeMethod: "S256",
    resource: "https://mcp.example.test",
    scope: "full",
    state: "opaque-state",
  };
}

test("validateAuthorizeParams accepts the primary resource and configured aliases", async (t) => {
  const { store, dir } = await makeStore();
  t.after(async () => {
    await store.persist();
    await rm(dir, { recursive: true, force: true });
  });
  const oauth = new OAuthService(makeConfig({
    resourceAliases: ["https://tunnel.example.test/v1/mcp/tunnel-1"],
  }), store);

  assert.deepEqual(oauth.validateAuthorizeParams(authorizeParams()), { ok: true });
  assert.deepEqual(
    oauth.validateAuthorizeParams({
      ...authorizeParams(),
      resource: "https://tunnel.example.test/v1/mcp/tunnel-1",
    }),
    { ok: true },
  );
  assert.equal(
    oauth.validateAuthorizeParams({
      ...authorizeParams(),
      resource: "https://tunnel.example.test/v1/mcp/tunnel-1/",
    }).ok,
    false,
  );
});

test("validateAuthorizeParams rejects client, redirect, PKCE, resource and response type mismatches", async (t) => {
  const { store, dir } = await makeStore();
  t.after(async () => {
    await store.persist();
    await rm(dir, { recursive: true, force: true });
  });
  const oauth = new OAuthService(makeConfig(), store);
  const base = authorizeParams();

  assert.equal(oauth.validateAuthorizeParams({ ...base, responseType: "token" }).ok, false);
  assert.equal(oauth.validateAuthorizeParams({ ...base, clientId: "other" }).ok, false);
  assert.equal(oauth.validateAuthorizeParams({ ...base, redirectUri: "https://evil.example/callback" }).ok, false);
  assert.equal(oauth.validateAuthorizeParams({ ...base, codeChallengeMethod: "plain" }).ok, false);
  assert.equal(oauth.validateAuthorizeParams({ ...base, resource: "https://other.example" }).ok, false);
});

test("redirect allowlist supports exact, bare exact, and prefix rules", async (t) => {
  const { store, dir } = await makeStore();
  t.after(async () => {
    await store.persist();
    await rm(dir, { recursive: true, force: true });
  });
  const oauth = new OAuthService(makeConfig({
    redirectUri: "",
    redirectUriAllowlist: [
      "exact:https://one.example/callback",
      "https://two.example/callback",
      "prefix:https://chatgpt.com/connector/oauth/",
    ],
  }), store);
  const base = authorizeParams();

  assert.equal(oauth.validateAuthorizeParams({ ...base, redirectUri: "https://one.example/callback" }).ok, true);
  assert.equal(oauth.validateAuthorizeParams({ ...base, redirectUri: "https://two.example/callback" }).ok, true);
  assert.equal(oauth.validateAuthorizeParams({ ...base, redirectUri: "https://chatgpt.com/connector/oauth/abc" }).ok, true);
  assert.equal(oauth.validateAuthorizeParams({ ...base, redirectUri: "https://one.example/other" }).ok, false);
});

test("authorization code exchange validates PKCE and consumes the code even on failure", async (t) => {
  const { store, dir } = await makeStore();
  t.after(async () => {
    await store.persist();
    await rm(dir, { recursive: true, force: true });
  });
  const oauth = new OAuthService(makeConfig(), store);
  const params = authorizeParams("correct-verifier");
  const code = oauth.issueAuthorizationCode(params);

  const failed = oauth.exchangeAuthorizationCode({
    code,
    redirectUri: params.redirectUri,
    verifier: "wrong-verifier",
    resource: params.resource,
  });
  assert.equal(failed, null);

  const replay = oauth.exchangeAuthorizationCode({
    code,
    redirectUri: params.redirectUri,
    verifier: "correct-verifier",
    resource: params.resource,
  });
  assert.equal(replay, null);
});

test("successful alias code exchange issues resource-bound tokens accepted by bearer validation", async (t) => {
  const { store, dir } = await makeStore();
  t.after(async () => {
    await store.persist();
    await rm(dir, { recursive: true, force: true });
  });
  const alias = "https://tunnel.example.test/v1/mcp/tunnel-1";
  const oauth = new OAuthService(makeConfig({ resourceAliases: [alias] }), store);
  const params = authorizeParams("correct-verifier");
  params.resource = alias;
  const code = oauth.issueAuthorizationCode(params);

  const pair = oauth.exchangeAuthorizationCode({
    code,
    redirectUri: params.redirectUri,
    verifier: "correct-verifier",
    resource: params.resource,
  });

  assert.ok(pair);
  assert.equal(pair.scope, "full");
  assert.equal(pair.expiresIn, 3600);
  assert.equal(oauth.validateAccessToken(pair.accessToken), true);
  assert.equal(store.getRefreshToken(pair.refreshToken)?.resource, params.resource);

  const refreshed = oauth.refreshAccessToken(pair.refreshToken, alias);
  assert.ok(refreshed);
  assert.equal(oauth.validateAccessToken(refreshed.accessToken), true);
});

test("resource alias removal blocks pending code exchange and existing refresh tokens", async (t) => {
  const { store, dir } = await makeStore();
  t.after(async () => {
    await store.persist();
    await rm(dir, { recursive: true, force: true });
  });
  const alias = "https://tunnel.example.test/v1/mcp/tunnel-1";
  const configured = new OAuthService(makeConfig({ resourceAliases: [alias] }), store);
  const params = authorizeParams("correct-verifier");
  params.resource = alias;
  const code = configured.issueAuthorizationCode(params);
  store.setRefreshToken("alias-refresh", { resource: alias });
  store.setAccessToken("alias-access", { resource: alias, expiresAt: Date.now() + 60_000 });

  const revoked = new OAuthService(makeConfig(), store);
  assert.equal(revoked.exchangeAuthorizationCode({
    code,
    redirectUri: params.redirectUri,
    verifier: "correct-verifier",
    resource: alias,
  }), null);
  assert.equal(revoked.refreshAccessToken("alias-refresh", alias), null);
  assert.equal(store.getRefreshToken("alias-refresh"), undefined);
  assert.equal(revoked.validateAccessToken("alias-access"), false);
});

test("refresh token rotates and cannot be replayed", async (t) => {
  const { store, dir } = await makeStore();
  t.after(async () => {
    await store.persist();
    await rm(dir, { recursive: true, force: true });
  });
  const oauth = new OAuthService(makeConfig(), store);
  store.setRefreshToken("old-refresh", { resource: "https://mcp.example.test" });

  const pair = oauth.refreshAccessToken("old-refresh", "https://mcp.example.test");
  assert.ok(pair);
  assert.equal(store.getRefreshToken("old-refresh"), undefined);
  assert.ok(store.getRefreshToken(pair.refreshToken));
  assert.equal(oauth.refreshAccessToken("old-refresh", "https://mcp.example.test"), null);
});

test("access tokens require a currently accepted resource and are deleted when invalid", async (t) => {
  const { store, dir } = await makeStore();
  t.after(async () => {
    await store.persist();
    await rm(dir, { recursive: true, force: true });
  });
  const alias = "https://tunnel.example.test/v1/mcp/tunnel-1";
  const oauth = new OAuthService(makeConfig({ resourceAliases: [alias] }), store);

  store.setAccessToken("expired", { resource: "https://mcp.example.test", expiresAt: Date.now() - 1 });
  store.setAccessToken("alias", { resource: alias, expiresAt: Date.now() + 60_000 });
  store.setAccessToken("wrong-resource", { resource: "https://other.example", expiresAt: Date.now() + 60_000 });

  assert.equal(oauth.validateAccessToken("expired"), false);
  assert.equal(store.getAccessToken("expired"), undefined);
  assert.equal(oauth.validateAccessToken("alias"), true);
  assert.equal(oauth.validateAccessToken("wrong-resource"), false);
  assert.equal(store.getAccessToken("wrong-resource"), undefined);
});

test("admin password and client credentials are validated", async (t) => {
  const { store, dir } = await makeStore();
  t.after(async () => {
    await store.persist();
    await rm(dir, { recursive: true, force: true });
  });
  const oauth = new OAuthService(makeConfig(), store);

  assert.equal(oauth.verifyAdminPassword("admin-password"), true);
  assert.equal(oauth.verifyAdminPassword("wrong"), false);
  assert.equal(oauth.validateClientCredentials("chatgpt", "client-secret"), true);
  assert.equal(oauth.validateClientCredentials("chatgpt", "wrong"), false);
});
