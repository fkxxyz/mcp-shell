import { createHash, timingSafeEqual } from "node:crypto";

// Kept stable for existing browser credential stores; no MCP authority.
export const READ_BASIC_USERNAME = "activity";

export function createReadBasicAuthorizationValidator(password: string) {
  const expectedPassword = digest(password);
  return (authorization: string | undefined): boolean => {
    const match = /^Basic\s+(.+)$/i.exec(authorization ?? "");
    if (!match) return false;

    try {
      const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      return colon >= 0 &&
        decoded.slice(0, colon) === READ_BASIC_USERNAME &&
        timingSafeEqual(digest(decoded.slice(colon + 1)), expectedPassword);
    } catch {
      return false;
    }
  };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
