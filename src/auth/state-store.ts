import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";

export type AuthorizationCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  expiresAt: number;
};

export type AccessToken = {
  resource: string;
  expiresAt: number;
};

export type RefreshToken = {
  resource: string;
};

type PersistedState = {
  authorizationCodes: Array<[string, AuthorizationCode]>;
  accessTokens: Array<[string, AccessToken]>;
  refreshTokens: Array<[string, RefreshToken]>;
};

export class AuthStateStore {
  private readonly authorizationCodes = new Map<string, AuthorizationCode>();
  private readonly accessTokens = new Map<string, AccessToken>();
  private readonly refreshTokens = new Map<string, RefreshToken>();
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly configDir: string,
    private readonly stateFile: string,
  ) {}

  async load(): Promise<void> {
    await mkdir(this.configDir, { recursive: true, mode: 0o700 });
    await chmod(this.configDir, 0o700);

    try {
      const raw = await readFile(this.stateFile, "utf8");
      const state = JSON.parse(raw) as PersistedState;

      this.authorizationCodes.clear();
      this.accessTokens.clear();
      this.refreshTokens.clear();

      for (const [key, value] of state.authorizationCodes ?? []) this.authorizationCodes.set(key, value);
      for (const [key, value] of state.accessTokens ?? []) this.accessTokens.set(key, value);
      for (const [key, value] of state.refreshTokens ?? []) this.refreshTokens.set(key, value);

      this.cleanupExpired();
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  getAuthorizationCode(code: string): AuthorizationCode | undefined {
    return this.authorizationCodes.get(code);
  }

  setAuthorizationCode(code: string, value: AuthorizationCode): void {
    this.authorizationCodes.set(code, value);
    this.persistSoon();
  }

  consumeAuthorizationCode(code: string): AuthorizationCode | undefined {
    const value = this.authorizationCodes.get(code);
    if (value) {
      this.authorizationCodes.delete(code);
      this.persistSoon();
    }
    return value;
  }

  getAccessToken(token: string): AccessToken | undefined {
    return this.accessTokens.get(token);
  }

  setAccessToken(token: string, value: AccessToken): void {
    this.accessTokens.set(token, value);
    this.persistSoon();
  }

  deleteAccessToken(token: string): void {
    if (this.accessTokens.delete(token)) this.persistSoon();
  }

  getRefreshToken(token: string): RefreshToken | undefined {
    return this.refreshTokens.get(token);
  }

  setRefreshToken(token: string, value: RefreshToken): void {
    this.refreshTokens.set(token, value);
    this.persistSoon();
  }

  consumeRefreshToken(token: string): RefreshToken | undefined {
    const value = this.refreshTokens.get(token);
    if (value) {
      this.refreshTokens.delete(token);
      this.persistSoon();
    }
    return value;
  }

  cleanupExpired(): boolean {
    const now = Date.now();
    let changed = false;

    for (const [code, value] of this.authorizationCodes) {
      if (value.expiresAt < now) {
        this.authorizationCodes.delete(code);
        changed = true;
      }
    }

    for (const [token, value] of this.accessTokens) {
      if (value.expiresAt < now) {
        this.accessTokens.delete(token);
        changed = true;
      }
    }

    return changed;
  }

  persistSoon(): void {
    void this.persist().catch((error) => {
      console.error("Failed to persist OAuth state:", error);
    });
  }

  async persist(): Promise<void> {
    this.persistQueue = this.persistQueue.then(async () => {
      const state: PersistedState = {
        authorizationCodes: [...this.authorizationCodes.entries()],
        accessTokens: [...this.accessTokens.entries()],
        refreshTokens: [...this.refreshTokens.entries()],
      };

      await mkdir(this.configDir, { recursive: true, mode: 0o700 });
      const tmp = `${this.stateFile}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.stateFile);
      await chmod(this.stateFile, 0o600);
    });

    return this.persistQueue;
  }
}
