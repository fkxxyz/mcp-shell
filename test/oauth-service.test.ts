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

test("validateAuthorizeParams accepts the configured OAuth request", async (t) => {
  const { store, dir } = await makeStore();
  t.after(async () => {
    await store.persist();
    await rm(dir, { recursive: true, force: true });
  });
  const oauth = new OAuthService(makeConfig(), store);

  assert.deepEqual(oauth.validateAuthorizeParams(authorizeParams()), { ok: true });
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
  // Any absolute http(s) resource is accepted (tunnel-fronted clients present
  // the tunnel's canonical resource URL); malformed resources are rejected.
  assert.equal(oauth.validateAuthorizeParams({ ...base, resource: "https://other.example" }).ok, true);
  assert.equal(oauth.validateAuthorizeParams({ ...base, resource: "not-a-url" }).ok, false);
  assert.equal(oauth.validateAuthorizeParams({ ...base, resource: "" }).ok, false);
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

test("successful code exchange issues an access token and refresh token", async (t) => {
  const { store, dir } = await makeStore();
  t.after(async () => {
    await store.persist();
    await rm(dir, { recursive: true, force: true });
  });
  const oauth = new OAuthService(makeConfig(), store);
  const params = authorizeParams("correct-verifier");
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

test("expired access tokens are rejected and deleted; resource binding is not enforced", async (t) => {
  const { store, dir } = await makeStore();
  t.after(async () => {
    await store.persist();
    await rm(dir, { recursive: true, force: true });
  });
  const oauth = new OAuthService(makeConfig(), store);

  store.setAccessToken("expired", { resource: "https://mcp.example.test", expiresAt: Date.now() - 1 });
  store.setAccessToken("foreign-resource", { resource: "https://other.example", expiresAt: Date.now() + 60_000 });

  assert.equal(oauth.validateAccessToken("expired"), false);
  assert.equal(store.getAccessToken("expired"), undefined);
  // Tokens issued for a foreign (e.g. tunnel-canonical) resource are accepted;
  // only expiry and presence are enforced.
  assert.equal(oauth.validateAccessToken("foreign-resource"), true);
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
