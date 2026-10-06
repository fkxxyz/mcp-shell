import assert from "node:assert/strict";
import test from "node:test";
import { createInputPreview } from "../src/observability/input-preview.js";

test("input preview preserves small JSON-like tool arguments", () => {
  assert.deepEqual(createInputPreview({
    shell_id: 7,
    path: "src/foo.ts",
    offset: 10,
    enabled: true,
    optional: null,
  }), {
    shell_id: 7,
    path: "src/foo.ts",
    offset: 10,
    enabled: true,
    optional: null,
  });
});

test("input preview bounds strings, collection width, and nesting depth", () => {
  const long = "x".repeat(400);
  const preview = createInputPreview({
    content: long,
    items: Array.from({ length: 20 }, (_, index) => ({ index, nested: { deeper: { value: long } } })),
    wide: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`key-${index}`, index])),
    a: 1,
    b: 2,
    c: 3,
    d: 4,
    e: 5,
    f: 6,
    g: 7,
  });

  assert.ok(preview);
  assert.equal((preview.content as string).length, 256);
  assert.equal((preview.content as string).endsWith("…"), true);
  assert.equal((preview.items as unknown[]).length, 4);
  assert.equal(Object.keys(preview.wide as object).length, 4);
  assert.deepEqual((preview.items as any[])[0], {});
});

test("input preview has a bounded serialized size under pathological input", () => {
  const pathological = Object.fromEntries(
    Array.from({ length: 40 }, (_, argumentIndex) => [
      `argument-${argumentIndex}`,
      Object.fromEntries(
        Array.from({ length: 8 }, (_, nestedIndex) => [
          `nested-${nestedIndex}`,
          "x".repeat(2_000),
        ]),
      ),
    ]),
  );

  const preview = createInputPreview(pathological)!;
  const serializedBytes = Buffer.byteLength(JSON.stringify(preview), "utf8");
  assert.ok(serializedBytes <= 64 * 1024, `preview exceeded 64 KiB: ${serializedBytes} bytes`);
});

test("input preview truncates strings without splitting surrogate pairs", () => {
  const preview = createInputPreview({ value: `${"x".repeat(254)}😀tail` })!;
  assert.equal(preview.value, `${"x".repeat(254)}…`);
});

test("input preview does not mutate the original input", () => {
  const input = { path: "a.ts", nested: { value: "original" } };
  const preview = createInputPreview(input)!;
  (preview.nested as Record<string, unknown>).value = "changed";
  assert.equal(input.nested.value, "original");
});
