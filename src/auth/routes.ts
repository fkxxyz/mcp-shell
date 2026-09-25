import { Router, type Request, type Response } from "express";
import type { RemoteAppConfig } from "../config.js";
import { OAuthService, type AuthorizeParams } from "./oauth-service.js";

export function createOAuthRouter(config: RemoteAppConfig, oauth: OAuthService): Router {
  const router = Router();

  router.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: config.publicBaseUrl,
      authorization_servers: [config.publicBaseUrl],
      scopes_supported: ["full"],
      bearer_methods_supported: ["header"],
    });
  });

  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: config.publicBaseUrl,
      authorization_endpoint: `${config.publicBaseUrl}/authorize`,
      token_endpoint: `${config.publicBaseUrl}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      scopes_supported: ["full"],
    });
  });

  router.get("/authorize", (req, res) => {
    const parsed = parseAuthorizeParams(req);
    const validation = oauth.validateAuthorizeParams(parsed);
    if (!validation.ok) return oauthError(res, validation.status, validation.error);

    return res.status(200).type("html").send(renderAuthorizePage(parsed));
  });

  router.post("/authorize", (req, res) => {
    const parsed = parseAuthorizeParams(req);
    const validation = oauth.validateAuthorizeParams(parsed);
    if (!validation.ok) return oauthError(res, validation.status, validation.error);

    if (!oauth.verifyAdminPassword(String(req.body.password ?? ""))) {
      return res.status(401).type("text").send("Invalid password");
    }

    const code = oauth.issueAuthorizationCode(parsed);
    const callback = new URL(parsed.redirectUri);
    callback.searchParams.set("code", code);
    if (parsed.state) callback.searchParams.set("state", parsed.state);

    return res.redirect(302, callback.toString());
  });

  router.post("/token", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");

    const credentials = parseClientCredentials(req);
    if (!oauth.validateClientCredentials(credentials.clientId, credentials.clientSecret)) {
      res.setHeader("WWW-Authenticate", 'Basic realm="mcp-oauth"');
      return res.status(401).json({ error: "invalid_client" });
    }

    const grantType = String(req.body.grant_type ?? "");
    if (grantType === "authorization_code") {
      const pair = oauth.exchangeAuthorizationCode({
        code: String(req.body.code ?? ""),
        redirectUri: String(req.body.redirect_uri ?? ""),
        verifier: String(req.body.code_verifier ?? ""),
        resource: String(req.body.resource ?? config.publicBaseUrl),
      });
      if (!pair) return res.status(400).json({ error: "invalid_grant" });
      return sendTokenPair(res, pair);
    }

    if (grantType === "refresh_token") {
      const pair = oauth.refreshAccessToken(
        String(req.body.refresh_token ?? ""),
        String(req.body.resource ?? config.publicBaseUrl),
      );
      if (!pair) return res.status(400).json({ error: "invalid_grant" });
      return sendTokenPair(res, pair);
    }

    return res.status(400).json({ error: "unsupported_grant_type" });
  });

  return router;
}

function parseAuthorizeParams(req: Request): AuthorizeParams {
  const source = req.method === "POST" ? req.body : req.query;
  return {
    responseType: String(source.response_type ?? ""),
    clientId: String(source.client_id ?? ""),
    redirectUri: String(source.redirect_uri ?? ""),
    codeChallenge: String(source.code_challenge ?? ""),
    codeChallengeMethod: String(source.code_challenge_method ?? ""),
    resource: String(source.resource ?? ""),
    scope: String(source.scope ?? "full"),
    state: source.state == null ? undefined : String(source.state),
  };
}

function parseClientCredentials(req: Request): { clientId: string; clientSecret: string } {
  let clientId = String(req.body.client_id ?? "");
  let clientSecret = String(req.body.client_secret ?? "");
  const authorization = req.header("authorization");

  if (authorization?.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      if (colon >= 0) {
        clientId = decoded.slice(0, colon);
        clientSecret = decoded.slice(colon + 1);
      }
    } catch {
      return { clientId: "", clientSecret: "" };
    }
  }

  return { clientId, clientSecret };
}

function sendTokenPair(res: Response, pair: { accessToken: string; refreshToken: string; expiresIn: number; scope: string }) {
  return res.status(200).json({
    access_token: pair.accessToken,
    token_type: "Bearer",
    expires_in: pair.expiresIn,
    refresh_token: pair.refreshToken,
    scope: pair.scope,
  });
}

function renderAuthorizePage(params: AuthorizeParams): string {
  return `<!doctype html>
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
    ${hidden("response_type", params.responseType)}
    ${hidden("client_id", params.clientId)}
    ${hidden("redirect_uri", params.redirectUri)}
    ${hidden("code_challenge", params.codeChallenge)}
    ${hidden("code_challenge_method", "S256")}
    ${hidden("resource", params.resource)}
    ${hidden("scope", params.scope)}
    ${params.state ? hidden("state", params.state) : ""}
    <label>
      Password:
      <input type="password" name="password" autofocus required>
    </label>
    <button type="submit">Authorize</button>
  </form>
</body>
</html>`;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function oauthError(res: Response, status: number, error: string) {
  return res.status(status).json({ error });
}
