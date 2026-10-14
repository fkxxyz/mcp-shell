import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadOAuthClients } from "../src/auth/oauth-clients.js";

const emptyEnv = {};
const secret = "confidential-client-secret-with-more-than-32-chars";

test("loads public and confidential OAuth clients from a private YAML file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-oauth-clients-"));
  const file = join(dir, "oauth-clients.yaml");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(file, [
    "version: 1",
    "clients:",
    "  - clientId: public-app",
    "    name: Public app",
    "    authentication: public",
    "    redirectUris:",
    "      - type: exact",
    "        value: http://127.0.0.1:43123/callback",
    "  - clientId: private-app",
    "    name: Private app",
    "    authentication: confidential",
    `    secret: ${secret}`,
    "    redirectUris:",
    "      - type: prefix",
    "        value: https://app.example.test/oauth/",
    "",
  ].join("\n"), { mode: 0o600 });
  await chmod(file, 0o600);

  const result = await loadOAuthClients(file, emptyEnv);
  assert.equal(result.legacy, false);
  assert.deepEqual(result.clients.map(({ clientId, authentication }) => ({ clientId, authentication })), [
    { clientId: "public-app", authentication: "public" },
    { clientId: "private-app", authentication: "confidential" },
  ]);
});

test("rejects duplicate IDs, broad redirect prefixes, and duplicate YAML keys", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-oauth-clients-"));
  const file = join(dir, "oauth-clients.yaml");
  t.after(() => rm(dir, { recursive: true, force: true }));

  const prefixConfig = (value: string) => [
    "version: 1",
    "clients:",
    "  - clientId: app",
    "    name: App",
    "    authentication: public",
    "    redirectUris:",
    "      - type: prefix",
    `        value: ${value}`,
    "",
  ].join("\n");
  await writeFile(file, prefixConfig("https://example.test/unsafe"), { mode: 0o600 });
  await assert.rejects(() => loadOAuthClients(file, emptyEnv), /prefix must be a non-root HTTP\(S\) path ending in \/ /);

  await writeFile(file, prefixConfig("https://example.test/"), { mode: 0o600 });
  await assert.rejects(() => loadOAuthClients(file, emptyEnv), /prefix must be a non-root HTTP\(S\) path/);

  await writeFile(file, [
    "version: 1",
    "clients:",
    "  - clientId: app",
    "    name: App",
    "    authentication: public",
    "    redirectUris: [{ type: exact, value: 'https://example.test/callback' }]",
    "  - clientId: app",
    "    name: Duplicate",
    "    authentication: public",
    "    redirectUris: [{ type: exact, value: 'https://example.test/other' }]",
    "",
  ].join("\n"), { mode: 0o600 });
  await assert.rejects(() => loadOAuthClients(file, emptyEnv), /Duplicate OAuth clientId/);

  await writeFile(file, "version: 1\nversion: 1\nclients: []\n", { mode: 0o600 });
  await assert.rejects(() => loadOAuthClients(file, emptyEnv), /Invalid OAuth client YAML/);
});

test("requires owner-only permissions and rejects mixed legacy/new configuration", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-oauth-clients-"));
  const file = join(dir, "oauth-clients.yaml");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(file, "version: 1\nclients: []\n", { mode: 0o600 });

  await chmod(file, 0o644);
  await assert.rejects(() => loadOAuthClients(file, emptyEnv), /must have mode 0600/);
  await chmod(file, 0o600);
  await assert.rejects(() => loadOAuthClients(file, {
    OAUTH_CLIENT_ID: "legacy",
    OAUTH_CLIENT_SECRET: secret,
  }), /Remove legacy OAUTH_CLIENT_/);
});

test("legacy environment settings load one client until migration", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-oauth-clients-"));
  const file = join(dir, "oauth-clients.yaml");
  t.after(() => rm(dir, { recursive: true, force: true }));

  const result = await loadOAuthClients(file, {
    OAUTH_CLIENT_ID: "old-client",
    OAUTH_CLIENT_SECRET: "legacy-secret",
    OAUTH_REDIRECT_URI_ALLOWLIST: "prefix:https://client.example.test/oauth/",
  });
  assert.equal(result.legacy, true);
  assert.deepEqual(result.clients[0]?.redirectUris, [
    { type: "prefix", value: "https://client.example.test/oauth/" },
  ]);
});
