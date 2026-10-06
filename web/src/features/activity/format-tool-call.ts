import type { ToolCallSummaryDto } from "../../../../src/contracts/activity";

const ARG_PRIORITY_GROUPS = [
  ["name"],
  ["path", "filePath", "directory", "cwd"],
  ["command", "query", "newName"],
  ["line", "character", "offset", "limit"],
  ["scope", "severity", "extension", "includeDeclaration", "timeout"],
  ["patchText", "edits", "content"],
  ["shell_id"],
] as const;

const priority = new Map<string, number>(
  ARG_PRIORITY_GROUPS.flat().map((name, index) => [name, index]),
);

export function formatToolCall(call: Pick<ToolCallSummaryDto, "tool" | "input_preview">): string {
  const input = call.input_preview;
  if (!input) return `${call.tool}()`;

  const args = Object.entries(input)
    .sort(([left], [right]) => compareArgumentNames(left, right))
    .map(([name, value]) => `${name}=${formatValue(value)}`);

  return `${call.tool}(${args.join(", ")})`;
}

function compareArgumentNames(left: string, right: string): number {
  const leftPriority = priority.get(left) ?? Number.POSITIVE_INFINITY;
  const rightPriority = priority.get(right) ?? Number.POSITIVE_INFINITY;
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  return left < right ? -1 : left > right ? 1 : 0;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? "[]" : "[…]";
  if (typeof value === "object") return Object.keys(value as object).length === 0 ? "{}" : "{…}";
  return JSON.stringify(String(value));
}
