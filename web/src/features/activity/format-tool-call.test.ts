import { describe, expect, it } from "vitest";
import { formatToolCall } from "./format-tool-call";

describe("formatToolCall", () => {
  it("orders known arguments by semantic importance and shell_id last", () => {
    expect(formatToolCall({
      tool: "example",
      input_preview: {
        shell_id: 42,
        limit: 100,
        filePath: "src/foo.ts",
        path: "README.md",
        name: "symbol",
        command: "npm test",
      },
    })).toBe('example(name="symbol", path="README.md", filePath="src/foo.ts", command="npm test", limit=100, shell_id=42)');
  });

  it("keeps unknown arguments after known arguments in stable name order", () => {
    expect(formatToolCall({
      tool: "future_tool",
      input_preview: { zebra: 1, path: "a.ts", alpha: true },
    })).toBe('future_tool(path="a.ts", alpha=true, zebra=1)');
  });

  it("formats strings safely and collapses structured values", () => {
    expect(formatToolCall({
      tool: "edit",
      input_preview: {
        path: "a\n\"b.ts",
        edits: [{ oldText: "a", newText: "b" }],
        metadata: { source: "test" },
      },
    })).toBe('edit(path="a\\n\\\"b.ts", edits=[…], metadata={…})');
  });

  it("falls back to an empty invocation when no preview is available", () => {
    expect(formatToolCall({ tool: "read", input_preview: null })).toBe("read()");
  });
});
