import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { RemoteAppConfig } from "../config.js";
import type { OAuthClient } from "./oauth-clients.js";
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

export type TokenEndpointAuthMethod = "none" | "client_secret_basic" | "client_secret_post";

export class OAuthService {
  private readonly acceptedResources: ReadonlySet<string>;
  private readonly clients: ReadonlyMap<string, OAuthClient>;

  constructor(
    private readonly config: RemoteAppConfig,
    private readonly state: AuthStateStore,
  ) {
    this.clients = new Map(config.oauth.clients.map((client) => [client.clientId, client]));
    this.acceptedResources = new Set([
      config.publicBaseUrl,
      ...config.oauth.resourceAliases,
    ]);
  }

  validateAuthorizeParams(input: AuthorizeParams): { ok: true } | { ok: false; status: number; error: string } {
    if (input.responseType !== "code") return { ok: false, status: 400, error: "unsupported_response_type" };
    const client = this.clients.get(input.clientId);
    if (!client) return { ok: false, status: 400, error: "invalid_client" };
    if (!this.isAllowedRedirectUri(client, input.redirectUri)) return { ok: false, status: 400, error: "invalid_redirect_uri" };
    if (!input.codeChallenge || input.codeChallengeMethod !== "S256") return { ok: false, status: 400, error: "invalid_pkce" };
    if (!this.isAcceptedResource(input.resource)) return { ok: false, status: 400, error: "invalid_resource" };
    return { ok: true };
  }

  clientName(clientId: string): string | undefined {
    return this.clients.get(clientId)?.name;
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

  validateClientCredentials(
    clientId: string,
    method: TokenEndpointAuthMethod,
    clientSecret?: string,
  ): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;
    if (client.authentication === "public") return method === "none" && clientSecret === undefined;
    return method !== "none" && clientSecret !== undefined && safeEqual(clientSecret, client.secret);
  }

  exchangeAuthorizationCode(input: {
    clientId: string;
    code: string;
    redirectUri: string;
    verifier: string;
    resource: string;
  }): TokenPair | null {
    const record = this.state.consumeAuthorizationCode(input.code);
    if (
      !record ||
      record.expiresAt < Date.now() ||
      record.clientId !== input.clientId ||
      !this.clients.has(input.clientId) ||
      input.redirectUri !== record.redirectUri ||
      input.resource !== record.resource ||
      !this.isAcceptedResource(record.resource) ||
      !input.verifier ||
      pkceS256(input.verifier) !== record.codeChallenge
    ) {
      return null;
    }

    return this.issueTokenPair(record.clientId, record.resource);
  }

  refreshAccessToken(clientId: string, refreshToken: string, resource: string): TokenPair | null {
    const record = this.state.getRefreshToken(refreshToken);
    if (!record) return null;
    if (record.clientId !== clientId || !this.clients.has(clientId)) return null;
    if (!this.isAcceptedResource(record.resource)) {
      this.state.consumeRefreshToken(refreshToken);
      return null;
    }
    if (record.resource !== resource) return null;

    this.state.consumeRefreshToken(refreshToken);
    return this.issueTokenPair(record.clientId, record.resource);
  }

  validateAccessToken(token: string): boolean {
    const record = this.state.getAccessToken(token);
    if (!record || record.expiresAt < Date.now() || !this.isAcceptedResource(record.resource) || !this.clients.has(record.clientId)) {
      if (record) this.state.deleteAccessToken(token);
      return false;
    }
    return true;
  }

  private issueTokenPair(clientId: string, resource: string): TokenPair {
    const accessToken = randomToken();
    const refreshToken = randomToken();

    this.state.setAccessToken(accessToken, {
      clientId,
      resource,
      expiresAt: Date.now() + ACCESS_TTL_MS,
    });
    this.state.setRefreshToken(refreshToken, { clientId, resource });

    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(ACCESS_TTL_MS / 1000),
      scope: "full",
    };
  }

  private isAcceptedResource(resource: string): boolean {
    return this.acceptedResources.has(resource);
  }

  private isAllowedRedirectUri(client: OAuthClient, uri: string): boolean {
    return client.redirectUris.some((rule) => rule.type === "exact"
      ? uri === rule.value
      : uri.startsWith(rule.value));
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
