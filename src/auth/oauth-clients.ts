import { readFile, stat } from "node:fs/promises";
import { parseDocument } from "yaml";
import { z } from "zod";

const redirectRuleSchema = z.object({
  type: z.enum(["exact", "prefix"]),
  value: z.string().min(1),
}).strict();

const baseClientSchema = z.object({
  clientId: z.string().min(1).max(256),
  name: z.string().min(1).max(128),
  redirectUris: z.array(redirectRuleSchema).min(1),
}).strict();

const clientSchema = z.discriminatedUnion("authentication", [
  baseClientSchema.extend({
    authentication: z.literal("public"),
    secret: z.never().optional(),
  }).strict(),
  baseClientSchema.extend({
    authentication: z.literal("confidential"),
    secret: z.string().min(32),
  }).strict(),
]);

const clientsFileSchema = z.object({
  version: z.literal(1),
  clients: z.array(clientSchema).min(1),
}).strict();

export type OAuthClient = z.infer<typeof clientSchema>;
export type OAuthRedirectRule = z.infer<typeof redirectRuleSchema>;

export type OAuthClientEnvironment = {
  OAUTH_CLIENT_ID?: string;
  OAUTH_CLIENT_SECRET?: string;
  OAUTH_REDIRECT_URI?: string;
  OAUTH_REDIRECT_URI_ALLOWLIST?: string;
};

export async function loadOAuthClients(
  file: string,
  env: OAuthClientEnvironment,
): Promise<{ clients: OAuthClient[]; legacy: boolean }> {
  const hasLegacyConfiguration = Boolean(
    env.OAUTH_CLIENT_ID || env.OAUTH_CLIENT_SECRET || env.OAUTH_REDIRECT_URI || env.OAUTH_REDIRECT_URI_ALLOWLIST,
  );

  try {
    const metadata = await stat(file);
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error(`OAuth client file must have mode 0600: ${file}`);
    }
    if (hasLegacyConfiguration) {
      throw new Error(`Remove legacy OAUTH_CLIENT_* and OAUTH_REDIRECT_URI* settings from the environment after creating ${file}`);
    }

    const document = parseDocument(await readFile(file, "utf8"), { uniqueKeys: true });
    if (document.errors.length > 0) {
      throw new Error(`Invalid OAuth client YAML in ${file}: ${document.errors[0]?.message}`);
    }
    const parsed = clientsFileSchema.safeParse(document.toJS());
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`Invalid OAuth client configuration in ${file}: ${issue?.path.join(".") || "root"}: ${issue?.message}`);
    }

    const clients = parsed.data.clients;
    validateClients(clients, file);
    return { clients, legacy: false };
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (!env.OAUTH_CLIENT_ID && !env.OAUTH_CLIENT_SECRET) {
    throw new Error(`OAuth client file not found: ${file}. Add at least one client or configure legacy OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET temporarily.`);
  }
  if (!env.OAUTH_CLIENT_ID || !env.OAUTH_CLIENT_SECRET) {
    throw new Error("Legacy OAuth configuration requires both OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET");
  }

  const redirectUris: OAuthRedirectRule[] = [];
  if (env.OAUTH_REDIRECT_URI) redirectUris.push({ type: "exact", value: env.OAUTH_REDIRECT_URI });
  for (const entry of (env.OAUTH_REDIRECT_URI_ALLOWLIST ?? "").split(",").map((value) => value.trim()).filter(Boolean)) {
    if (entry.startsWith("prefix:")) redirectUris.push({ type: "prefix", value: entry.slice("prefix:".length) });
    else if (entry.startsWith("exact:")) redirectUris.push({ type: "exact", value: entry.slice("exact:".length) });
    else redirectUris.push({ type: "exact", value: entry });
  }
  if (redirectUris.length === 0) {
    throw new Error("Legacy OAuth configuration requires OAUTH_REDIRECT_URI or OAUTH_REDIRECT_URI_ALLOWLIST");
  }

  const legacyClient: OAuthClient = {
    clientId: env.OAUTH_CLIENT_ID,
    name: env.OAUTH_CLIENT_ID,
    authentication: "confidential",
    secret: env.OAUTH_CLIENT_SECRET,
    redirectUris,
  };
  validateClients([legacyClient], file);
  console.warn(`Using deprecated single-client OAuth environment settings; migrate them to ${file}`);
  return { clients: [legacyClient], legacy: true };
}

function validateClients(clients: OAuthClient[], file: string): void {
  const clientIds = new Set<string>();
  for (const client of clients) {
    if (clientIds.has(client.clientId)) {
      throw new Error(`Duplicate OAuth clientId "${client.clientId}" in ${file}`);
    }
    clientIds.add(client.clientId);

    for (const rule of client.redirectUris) {
      let parsed: URL;
      try {
        parsed = new URL(rule.value);
      } catch {
        throw new Error(`Invalid ${rule.type} redirect URI for OAuth client "${client.clientId}" in ${file}`);
      }
      if (parsed.username || parsed.password || parsed.hash || /[\x00-\x20\x7f]/.test(rule.value)) {
        throw new Error(`Unsafe redirect URI for OAuth client "${client.clientId}" in ${file}`);
      }
      if (!/^https?:$/.test(parsed.protocol) && (!parsed.host || ["javascript:", "data:", "file:"].includes(parsed.protocol))) {
        throw new Error(`Unsupported redirect URI scheme for OAuth client "${client.clientId}" in ${file}`);
      }
      if (rule.type === "prefix" && (!/^https?:$/.test(parsed.protocol) || parsed.pathname === "/" || !parsed.pathname.endsWith("/") || parsed.search)) {
        throw new Error(`OAuth redirect prefix must be a non-root HTTP(S) path ending in / for client "${client.clientId}"`);
      }
    }
  }
}
