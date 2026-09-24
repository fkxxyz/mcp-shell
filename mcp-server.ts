import express, { type Request, type Response, type NextFunction } from "express";
import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

async function main() {
/**
 * Minimal authenticated remote MCP demo for ChatGPT.
 *
 * One process implements:
 *   - OAuth 2.1-ish Authorization Code + PKCE + Refresh Token
 *   - OAuth discovery metadata
 *   - MCP Streamable HTTP
 *   - one MCP tool: `hello`, which lists `/`
 *
 * Deliberately minimal:
 *   - OAuth state persists in ~/.mcp-shell/state.json
 *   - exactly one OAuth client and one owner password
 *   - auth success == full trust
 *
 * Configuration:
 *   ~/.mcp-shell/env
 *
 * Required keys:
 *   PUBLIC_BASE_URL=https://mcp.example.com
 *   OAUTH_CLIENT_ID=chatgpt
 *   OAUTH_CLIENT_SECRET=<long random secret>
 *   OAUTH_REDIRECT_URI=<optional exact callback URI>
 *   OAUTH_REDIRECT_URI_ALLOWLIST=<comma-separated exact:/prefix: rules>
 *   ADMIN_PASSWORD=<your login password>
 *
 * Optional:
 *   PORT=3000
 *
 * Existing process environment variables override values from the config file.
 */

const CONFIG_DIR = join(homedir(), ".mcp-shell");
const ENV_FILE = join(CONFIG_DIR, "env");
const STATE_FILE = join(CONFIG_DIR, "state.json");

await loadEnvFile();

const PORT = Number(process.env.PORT ?? 3000);
const BASE = mustEnv("PUBLIC_BASE_URL").replace(/\/+$/, "");
const CLIENT_ID = mustEnv("OAUTH_CLIENT_ID");
const CLIENT_SECRET = mustEnv("OAUTH_CLIENT_SECRET");
const REDIRECT_URI = process.env.OAUTH_REDIRECT_URI ?? "";
const REDIRECT_URI_ALLOWLIST = (process.env.OAUTH_REDIRECT_URI_ALLOWLIST ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ADMIN_PASSWORD = mustEnv("ADMIN_PASSWORD");

const ACCESS_TTL_MS = 60 * 60 * 1000; // 1 hour
const CODE_TTL_MS = 5 * 60 * 1000;    // 5 minutes

type AuthorizationCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  expiresAt: number;
};

type AccessToken = {
  resource: string;
  expiresAt: number;
};

type RefreshToken = {
  resource: string;
};

const authorizationCodes = new Map<string, AuthorizationCode>();
const accessTokens = new Map<string, AccessToken>();
const refreshTokens = new Map<string, RefreshToken>();

type PersistedState = {
  authorizationCodes: Array<[string, AuthorizationCode]>;
  accessTokens: Array<[string, AccessToken]>;
  refreshTokens: Array<[string, RefreshToken]>;
};

let persistQueue: Promise<void> = Promise.resolve();

async function loadState() {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await chmod(CONFIG_DIR, 0o700);

  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const state = JSON.parse(raw) as PersistedState;

    authorizationCodes.clear();
    accessTokens.clear();
    refreshTokens.clear();

    for (const [k, v] of state.authorizationCodes ?? []) authorizationCodes.set(k, v);
    for (const [k, v] of state.accessTokens ?? []) accessTokens.set(k, v);
    for (const [k, v] of state.refreshTokens ?? []) refreshTokens.set(k, v);

    cleanupExpiredState();
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
    await persistState();
  }
}

function persistState(): Promise<void> {
  persistQueue = persistQueue.then(async () => {
    const state: PersistedState = {
      authorizationCodes: [...authorizationCodes.entries()],
      accessTokens: [...accessTokens.entries()],
      refreshTokens: [...refreshTokens.entries()],
    };

    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });

    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, STATE_FILE);
    await chmod(STATE_FILE, 0o600);
  });

  return persistQueue;
}

function persistSoon() {
  void persistState().catch((err) => {
    console.error("Failed to persist OAuth state:", err);
  });
}

function cleanupExpiredState() {
  const now = Date.now();
  let changed = false;

  for (const [code, v] of authorizationCodes) {
    if (v.expiresAt < now) {
      authorizationCodes.delete(code);
      changed = true;
    }
  }
  for (const [token, v] of accessTokens) {
    if (v.expiresAt < now) {
      accessTokens.delete(token);
      changed = true;
    }
  }

  return changed;
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

// ---------- OAuth discovery ----------

app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: BASE,
    authorization_servers: [BASE],
    scopes_supported: ["full"],
    bearer_methods_supported: ["header"],
  });
});

app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json({
    issuer: BASE,
    authorization_endpoint: `${BASE}/authorize`,
    token_endpoint: `${BASE}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
    ],
    scopes_supported: ["full"],
  });
});

// ---------- OAuth authorize ----------

app.get("/authorize", (req, res) => {
  const p = parseAuthorizeParams(req);
  if (!p.ok) return oauthError(res, p.status, p.error);

  // No login sessions: every authorization asks for the owner password.
  res
    .status(200)
    .type("html")
    .send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Authorize MCP</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body>
  <h2>Authorize ChatGPT MCP access</h2>
  <p>Successful login grants full access to this MCP server.</p>
  <form method="post" action="/authorize">
    ${hidden("response_type", p.value.responseType)}
    ${hidden("client_id", p.value.clientId)}
    ${hidden("redirect_uri", p.value.redirectUri)}
    ${hidden("code_challenge", p.value.codeChallenge)}
    ${hidden("code_challenge_method", "S256")}
    ${hidden("resource", p.value.resource)}
    ${hidden("scope", p.value.scope)}
    ${p.value.state ? hidden("state", p.value.state) : ""}
    <label>
      Password:
      <input type="password" name="password" autofocus required>
    </label>
    <button type="submit">Authorize</button>
  </form>
</body>
</html>`);
});

app.post("/authorize", (req, res) => {
  const p = parseAuthorizeParams(req);
  if (!p.ok) return oauthError(res, p.status, p.error);

  if (!safeEqual(String(req.body.password ?? ""), ADMIN_PASSWORD)) {
    return res.status(401).type("text").send("Invalid password");
  }

  const code = randomToken();
  authorizationCodes.set(code, {
    clientId: p.value.clientId,
    redirectUri: p.value.redirectUri,
    codeChallenge: p.value.codeChallenge,
    resource: p.value.resource,
    expiresAt: Date.now() + CODE_TTL_MS,
  });
  persistSoon();

  const callback = new URL(p.value.redirectUri);
  callback.searchParams.set("code", code);
  if (p.value.state) callback.searchParams.set("state", p.value.state);

  res.redirect(302, callback.toString());
});

// ---------- OAuth token ----------

app.post("/token", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");

  if (!validClientAuthentication(req)) {
    res.setHeader("WWW-Authenticate", 'Basic realm="mcp-oauth"');
    return res.status(401).json({ error: "invalid_client" });
  }

  const grantType = String(req.body.grant_type ?? "");

  if (grantType === "authorization_code") {
    const code = String(req.body.code ?? "");
    const redirectUri = String(req.body.redirect_uri ?? "");
    const verifier = String(req.body.code_verifier ?? "");
    const resource = String(req.body.resource ?? BASE);

    const record = authorizationCodes.get(code);

    // Authorization codes are one-shot even on a failed exchange.
    if (record) {
      authorizationCodes.delete(code);
      persistSoon();
    }

    if (
      !record ||
      record.expiresAt < Date.now() ||
      record.clientId !== CLIENT_ID ||
      redirectUri !== record.redirectUri ||
      resource !== record.resource ||
      !verifier ||
      pkceS256(verifier) !== record.codeChallenge
    ) {
      return res.status(400).json({ error: "invalid_grant" });
    }

    return sendTokenPair(res, record.resource);
  }

  if (grantType === "refresh_token") {
    const oldRefreshToken = String(req.body.refresh_token ?? "");
    const resource = String(req.body.resource ?? BASE);
    const record = refreshTokens.get(oldRefreshToken);

    if (!record || record.resource !== resource) {
      return res.status(400).json({ error: "invalid_grant" });
    }

    // Rotate refresh tokens.
    refreshTokens.delete(oldRefreshToken);
    persistSoon();
    return sendTokenPair(res, record.resource);
  }

  return res.status(400).json({ error: "unsupported_grant_type" });
});

// ---------- MCP auth ----------

function requireBearer(req: Request, res: Response, next: NextFunction) {
  const auth = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  const token = match?.[1];
  const record = token ? accessTokens.get(token) : undefined;

  if (!record || record.expiresAt < Date.now() || record.resource !== BASE) {
    if (token) {
      accessTokens.delete(token);
      persistSoon();
    }

    res.setHeader(
      "WWW-Authenticate",
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource", scope="full"`,
    );
    return res.status(401).json({ error: "unauthorized" });
  }

  next();
}

// ---------- MCP server ----------

function createMcpServer() {
  const server = new McpServer({
    name: "computer-demo",
    version: "0.1.0",
  });

  server.registerTool(
    "hello",
    {
      title: "Hello",
      description: "List the entries in the filesystem root directory (/).",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const entries = await readdir("/", { withFileTypes: true });
      const lines = entries
        .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
        .sort((a, b) => a.localeCompare(b));

      return {
        content: [
          {
            type: "text" as const,
            text: lines.join("\n"),
          },
        ],
      };
    },
  );

  return server;
}

const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post("/mcp", requireBearer, async (req, res) => {
  try {
    const sessionId = req.header("mcp-session-id");
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport;
        },
      });

      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) delete transports[id];
      };

      const server = createMcpServer();
      await server.connect(transport);
    } else {
      return res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: invalid or missing MCP session",
        },
        id: null,
      });
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", requireBearer, async (req, res) => {
  const sessionId = req.header("mcp-session-id");
  const transport = sessionId ? transports[sessionId] : undefined;

  if (!transport) {
    return res.status(400).type("text").send("Invalid or missing MCP session");
  }

  await transport.handleRequest(req, res);
});

app.delete("/mcp", requireBearer, async (req, res) => {
  const sessionId = req.header("mcp-session-id");
  const transport = sessionId ? transports[sessionId] : undefined;

  if (!transport) {
    return res.status(400).type("text").send("Invalid or missing MCP session");
  }

  await transport.handleRequest(req, res);
});

// ---------- Small helpers ----------

function parseAuthorizeParams(req: Request):
  | {
      ok: true;
      value: {
        responseType: string;
        clientId: string;
        redirectUri: string;
        codeChallenge: string;
        resource: string;
        scope: string;
        state?: string;
      };
    }
  | { ok: false; status: number; error: string } {
  const src = req.method === "POST" ? req.body : req.query;

  const responseType = String(src.response_type ?? "");
  const clientId = String(src.client_id ?? "");
  const redirectUri = String(src.redirect_uri ?? "");
  const codeChallenge = String(src.code_challenge ?? "");
  const codeChallengeMethod = String(src.code_challenge_method ?? "");
  const resource = String(src.resource ?? "");
  const scope = String(src.scope ?? "full");
  const state = src.state == null ? undefined : String(src.state);

  if (responseType !== "code") {
    return { ok: false, status: 400, error: "unsupported_response_type" };
  }
  if (clientId !== CLIENT_ID) {
    return { ok: false, status: 400, error: "invalid_client" };
  }
  if (!isAllowedRedirectUri(redirectUri)) {
    return { ok: false, status: 400, error: "invalid_redirect_uri" };
  }
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    return { ok: false, status: 400, error: "invalid_pkce" };
  }
  if (resource !== BASE) {
    return { ok: false, status: 400, error: "invalid_resource" };
  }

  return {
    ok: true,
    value: {
      responseType,
      clientId,
      redirectUri,
      codeChallenge,
      resource,
      scope,
      state,
    },
  };
}

function isAllowedRedirectUri(uri: string): boolean {
  // Optional exact URI for clients with a stable callback.
  if (REDIRECT_URI && uri === REDIRECT_URI) return true;

  // Configurable allowlist. Entries may be:
  //   exact:https://example.com/oauth/callback
  //   prefix:https://chatgpt.com/connector/oauth/
  //   prefix:https://other-agent.example/callback/
  //
  // Bare entries default to exact matching.
  for (const rule of REDIRECT_URI_ALLOWLIST) {
    if (rule.startsWith("prefix:")) {
      const prefix = rule.slice("prefix:".length);
      if (uri.startsWith(prefix)) return true;
      continue;
    }

    if (rule.startsWith("exact:")) {
      if (uri === rule.slice("exact:".length)) return true;
      continue;
    }

    if (uri === rule) return true;
  }

  return false;
}


function validClientAuthentication(req: Request): boolean {
  let clientId = String(req.body.client_id ?? "");
  let clientSecret = String(req.body.client_secret ?? "");

  const auth = req.header("authorization");
  if (auth?.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      if (colon >= 0) {
        clientId = decoded.slice(0, colon);
        clientSecret = decoded.slice(colon + 1);
      }
    } catch {
      return false;
    }
  }

  return clientId === CLIENT_ID && safeEqual(clientSecret, CLIENT_SECRET);
}

function sendTokenPair(res: Response, resource: string) {
  const accessToken = randomToken();
  const refreshToken = randomToken();

  accessTokens.set(accessToken, {
    resource,
    expiresAt: Date.now() + ACCESS_TTL_MS,
  });
  refreshTokens.set(refreshToken, { resource });
  persistSoon();

  return res.status(200).json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    refresh_token: refreshToken,
    scope: "full",
  });
}

function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function oauthError(res: Response, status: number, error: string) {
  return res.status(status).json({ error });
}

async function loadEnvFile() {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await chmod(CONFIG_DIR, 0o700);

  try {
    const raw = await readFile(ENV_FILE, "utf8");

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

      // Shell environment wins, config file supplies defaults.
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (err: any) {
    if (err?.code === "ENOENT") {
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

      await writeFile(ENV_FILE, template, { mode: 0o600 });
      await chmod(ENV_FILE, 0o600);

      throw new Error(
        `Created config template at ${ENV_FILE}. Edit it, then start the server again.`,
      );
    }

    throw err;
  }
}

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required configuration: ${name}`);
  if (value === "CHANGE_ME") {
    throw new Error(`Configuration ${name} is still CHANGE_ME in ${ENV_FILE}`);
  }
  return value;
}

// Opportunistic cleanup of expired short-lived state.
setInterval(() => {
  if (cleanupExpiredState()) persistSoon();
}, 60_000).unref();

await loadState();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP demo listening on 0.0.0.0:${PORT}`);
  console.log(`Public MCP URL: ${BASE}/mcp`);
  console.log(`OAuth issuer:   ${BASE}`);
  console.log(`Config file:    ${ENV_FILE}`);
  console.log(`State file:     ${STATE_FILE}`);
});

}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
