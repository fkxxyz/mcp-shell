import { readFile, stat } from "node:fs/promises";
import { parseDocument } from "yaml";
import { z } from "zod";

export const DEFAULT_UPSTREAM_TIMEOUT_MS = 60_000;

const upstreamFileSchema = z.object({
  version: z.literal(1),
  timeoutMs: z.number().int().positive().optional(),
  upstreams: z.array(z.object({
    name: z.string().min(1).max(64),
    url: z.string().min(1),
  }).strict()).default([]),
}).strict();

export type UpstreamDefinition = {
  name: string;
  url: URL;
};

export type UpstreamConfig = {
  timeoutMs: number;
  upstreams: UpstreamDefinition[];
};

/** Addresses that resolve back to this process; an upstream pointing here would call itself. */
export type SelfTarget = {
  port: number;
  publicBaseUrl?: string;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0", "[::]"]);

/** Missing file means no upstreams. Any invalid entry aborts startup. */
export async function loadUpstreamConfig(file: string, self: SelfTarget): Promise<UpstreamConfig> {
  let raw: string;
  try {
    const metadata = await stat(file);
    if ((metadata.mode & 0o077) !== 0) {
      // URLs may carry credentials in their path or query, so the file is owner-only like oauth-clients.yaml.
      throw new Error(`Upstream file must have mode 0600: ${file}`);
    }
    raw = await readFile(file, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return { timeoutMs: DEFAULT_UPSTREAM_TIMEOUT_MS, upstreams: [] };
    throw error;
  }

  const document = parseDocument(raw, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`Invalid upstream file ${file}: ${document.errors[0].message}`);
  }

  const parsed = upstreamFileSchema.safeParse(document.toJS());
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    throw new Error(`Invalid upstream file ${file}: ${field}: ${issue.message}`);
  }

  const seen = new Set<string>();
  const upstreams = parsed.data.upstreams.map((entry) => {
    if (seen.has(entry.name)) {
      throw new Error(`Invalid upstream file ${file}: duplicate upstream name "${entry.name}"`);
    }
    seen.add(entry.name);
    return { name: entry.name, url: parseUpstreamUrl(entry.name, entry.url, self) };
  });

  return {
    timeoutMs: parsed.data.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
    upstreams,
  };
}

function parseUpstreamUrl(name: string, value: string, self: SelfTarget): URL {
  const fail = (reason: string): never => {
    throw new Error(`Invalid upstream "${name}": ${reason}`);
  };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail(`url is not a valid absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail(`url must use http or https`);
  }
  if (url.username || url.password) {
    fail(`url must not contain credentials`);
  }
  if (isSelf(url, self)) {
    fail(`url points at this mcp-shell instance`);
  }
  return url;
}

function isSelf(url: URL, self: SelfTarget): boolean {
  if (self.publicBaseUrl && url.origin === new URL(self.publicBaseUrl).origin) return true;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return LOOPBACK_HOSTS.has(url.hostname) && port === self.port;
}
