import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import express from "express";
import type { Server } from "node:http";
import { createOAuthRouter } from "../src/auth/routes.js";
import { OAuthService } from "../src/auth/oauth-service.js";
import { makeConfig, makeStore, pkceChallenge } from "./helpers.js";

async function startAuthApp(overrides: Parameters<typeof makeConfig>[0] = {}) {
  const config = makeConfig(overrides);
  const { store, dir } = await makeStore();
  const oauth = new OAuthService(config, store);
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(createOAuthRouter(config, oauth));

  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP server address");

  return {
    config,
    oauth,
    store,
    dir,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await store.persist();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("OAuth discovery endpoints expose configured metadata", async (t) => {
  const ctx = await startAuthApp();
  t.after(() => ctx.close());

  const protectedResponse = await fetch(`${ctx.baseUrl}/.well-known/oauth-protected-resource`);
  assert.equal(protectedResponse.status, 200);
  assert.deepEqual(await protectedResponse.json(), {
    resource: ctx.config.publicBaseUrl,
    authorization_servers: [ctx.config.publicBaseUrl],
    scopes_supported: ["full"],
    bearer_methods_supported: ["header"],
  });

  const authorizationResponse = await fetch(`${ctx.baseUrl}/.well-known/oauth-authorization-server`);
  assert.equal(authorizationResponse.status, 200);
  const body = await authorizationResponse.json() as any;
  assert.equal(body.issuer, ctx.config.publicBaseUrl);
  assert.equal(body.authorization_endpoint, `${ctx.config.publicBaseUrl}/authorize`);
  assert.equal(body.token_endpoint, `${ctx.config.publicBaseUrl}/token`);
  assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
});

test("authorize GET validates parameters and renders escaped form values", async (t) => {
  const ctx = await startAuthApp();
  t.after(() => ctx.close());

  const verifier = "route-test-verifier";
  const url = new URL(`${ctx.baseUrl}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", ctx.config.oauth.clientId);
  url.searchParams.set("redirect_uri", ctx.config.oauth.redirectUri);
  url.searchParams.set("code_challenge", pkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", ctx.config.publicBaseUrl);
  url.searchParams.set("scope", "full");
  url.searchParams.set("state", `a\"<&'b`);

  const response = await fetch(url);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<form method="post" action="\/authorize">/);
  assert.match(html, /value="a&quot;&lt;&amp;&#39;b"/, "state should be HTML escaped");

  const bad = new URL(url);
  bad.searchParams.set("redirect_uri", "https://evil.example/callback");
  const badResponse = await fetch(bad);
  assert.equal(badResponse.status, 400);
  assert.deepEqual(await badResponse.json(), { error: "invalid_redirect_uri" });
});

test("token endpoint rejects invalid client credentials", async (t) => {
  const ctx = await startAuthApp();
  t.after(() => ctx.close());

  const response = await fetch(`${ctx.baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: "missing",
      client_id: "wrong",
      client_secret: "wrong",
    }),
  });

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), 'Basic realm="mcp-oauth"');
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "invalid_client" });
});

test("authorization code flow accepts a configured resource alias and code replay fails", async (t) => {
  const alias = "https://tunnel.example.test/v1/mcp/tunnel-1";
  const ctx = await startAuthApp({ resourceAliases: [alias] });
  t.after(() => ctx.close());

  const verifier = "http-verifier";
  const authorizeBody = new URLSearchParams({
    response_type: "code",
    client_id: ctx.config.oauth.clientId,
    redirect_uri: ctx.config.oauth.redirectUri,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
    resource: alias,
    scope: "full",
    state: "state-123",
    password: ctx.config.oauth.adminPassword,
  });

  const authorizeResponse = await fetch(`${ctx.baseUrl}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: authorizeBody,
  });
  assert.equal(authorizeResponse.status, 302);
  const location = authorizeResponse.headers.get("location");
  assert.ok(location);
  const callback = new URL(location);
  const code = callback.searchParams.get("code");
  assert.ok(code);
  assert.equal(callback.searchParams.get("state"), "state-123");

  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: ctx.config.oauth.redirectUri,
    code_verifier: verifier,
    resource: alias,
  });
  const basic = Buffer.from(`${ctx.config.oauth.clientId}:${ctx.config.oauth.clientSecret}`).toString("base64");
  const tokenResponse = await fetch(`${ctx.baseUrl}/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: tokenBody,
  });
  assert.equal(tokenResponse.status, 200);
  const pair = await tokenResponse.json() as any;
  assert.equal(pair.token_type, "Bearer");
  assert.equal(pair.scope, "full");
  assert.ok(pair.access_token);
  assert.ok(pair.refresh_token);
  assert.equal(ctx.oauth.validateAccessToken(pair.access_token), true);

  const replayResponse = await fetch(`${ctx.baseUrl}/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: tokenBody,
  });
  assert.equal(replayResponse.status, 400);
  assert.deepEqual(await replayResponse.json(), { error: "invalid_grant" });
});
