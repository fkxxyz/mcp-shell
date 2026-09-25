import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { RemoteAppConfig } from "../config.js";
import { AuthStateStore } from "./state-store.js";

const ACCESS_TTL_MS = 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;

export type AuthorizeParams = {
  responseType: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string;
  scope: string;
  state?: string;
};

export class OAuthService {
  constructor(
    private readonly config: RemoteAppConfig,
    private readonly state: AuthStateStore,
  ) {}

  validateAuthorizeParams(input: AuthorizeParams): { ok: true } | { ok: false; status: number; error: string } {
    if (input.responseType !== "code") return { ok: false, status: 400, error: "unsupported_response_type" };
    if (input.clientId !== this.config.oauth.clientId) return { ok: false, status: 400, error: "invalid_client" };
    if (!this.isAllowedRedirectUri(input.redirectUri)) return { ok: false, status: 400, error: "invalid_redirect_uri" };
    if (!input.codeChallenge || input.codeChallengeMethod !== "S256") return { ok: false, status: 400, error: "invalid_pkce" };
    if (input.resource !== this.config.publicBaseUrl) return { ok: false, status: 400, error: "invalid_resource" };
    return { ok: true };
  }

  verifyAdminPassword(password: string): boolean {
    return safeEqual(password, this.config.oauth.adminPassword);
  }

  issueAuthorizationCode(input: AuthorizeParams): string {
    const code = randomToken();
    this.state.setAuthorizationCode(code, {
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      resource: input.resource,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    return code;
  }

  validateClientCredentials(clientId: string, clientSecret: string): boolean {
    return clientId === this.config.oauth.clientId && safeEqual(clientSecret, this.config.oauth.clientSecret);
  }

  exchangeAuthorizationCode(input: {
    code: string;
    redirectUri: string;
    verifier: string;
    resource: string;
  }): TokenPair | null {
    const record = this.state.consumeAuthorizationCode(input.code);
    if (
      !record ||
      record.expiresAt < Date.now() ||
      record.clientId !== this.config.oauth.clientId ||
      input.redirectUri !== record.redirectUri ||
      input.resource !== record.resource ||
      !input.verifier ||
      pkceS256(input.verifier) !== record.codeChallenge
    ) {
      return null;
    }

    return this.issueTokenPair(record.resource);
  }

  refreshAccessToken(refreshToken: string, resource: string): TokenPair | null {
    const record = this.state.getRefreshToken(refreshToken);
    if (!record || record.resource !== resource) return null;

    this.state.consumeRefreshToken(refreshToken);
    return this.issueTokenPair(record.resource);
  }

  validateAccessToken(token: string): boolean {
    const record = this.state.getAccessToken(token);
    if (!record || record.expiresAt < Date.now() || record.resource !== this.config.publicBaseUrl) {
      if (record) this.state.deleteAccessToken(token);
      return false;
    }
    return true;
  }

  private issueTokenPair(resource: string): TokenPair {
    const accessToken = randomToken();
    const refreshToken = randomToken();

    this.state.setAccessToken(accessToken, {
      resource,
      expiresAt: Date.now() + ACCESS_TTL_MS,
    });
    this.state.setRefreshToken(refreshToken, { resource });

    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(ACCESS_TTL_MS / 1000),
      scope: "full",
    };
  }

  private isAllowedRedirectUri(uri: string): boolean {
    const { redirectUri, redirectUriAllowlist } = this.config.oauth;
    if (redirectUri && uri === redirectUri) return true;

    for (const rule of redirectUriAllowlist) {
      if (rule.startsWith("prefix:")) {
        if (uri.startsWith(rule.slice("prefix:".length))) return true;
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
}

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
};

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
