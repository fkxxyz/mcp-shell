const MAX_PREVIEW_DEPTH = 1;
const MAX_ARGUMENTS = 32;
const MAX_COLLECTION_ITEMS = 4;
const MAX_STRING_CHARS = 256;

export function createInputPreview(input: unknown): Record<string, unknown> | undefined {
  if (!isRecord(input)) return undefined;
  return previewRecord(input, 0, MAX_ARGUMENTS);
}

function previewValue(value: unknown, depth: number): unknown {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return truncateString(value);
  if (typeof value !== "object") return truncateString(String(value));

  if (depth >= MAX_PREVIEW_DEPTH) return Array.isArray(value) ? [] : {};
  if (Array.isArray(value)) {
    return value.slice(0, MAX_COLLECTION_ITEMS).map((item) => previewValue(item, depth + 1));
  }
  return previewRecord(value as Record<string, unknown>, depth + 1, MAX_COLLECTION_ITEMS);
}

function previewRecord(
  value: Record<string, unknown>,
  depth: number,
  maxItems: number,
): Record<string, unknown> {
  const entries = Object.entries(value)
    .slice(0, maxItems)
    .map(([key, item]) => [key, previewValue(item, depth)] as const);
  return Object.fromEntries(entries);
}

function truncateString(value: string): string {
  if (value.length <= MAX_STRING_CHARS) return value;

  const maxPrefixUnits = MAX_STRING_CHARS - 1;
  let prefixUnits = 0;
  for (const character of value) {
    if (prefixUnits + character.length > maxPrefixUnits) break;
    prefixUnits += character.length;
  }
  return `${value.slice(0, prefixUnits)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
