import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("activity frontend avoids executable HTML and dynamic-code sinks", async () => {
  const jsDir = join(process.cwd(), "web", "js");
  const files = (await readdir(jsDir)).filter((name) => name.endsWith(".js"));

  for (const file of files) {
    const source = await readFile(join(jsDir, file), "utf8");
    assert.doesNotMatch(source, /\.innerHTML\s*=/, `${file} must render untrusted content as text`);
    assert.doesNotMatch(source, /insertAdjacentHTML\s*\(/, `${file} must not inject HTML`);
    assert.doesNotMatch(source, /document\.write\s*\(/, `${file} must not write executable markup`);
    assert.doesNotMatch(source, /\beval\s*\(/, `${file} must not evaluate dynamic code`);
    assert.doesNotMatch(source, /new\s+Function\s*\(/, `${file} must not construct dynamic code`);
  }
});

test("activity HTML has no inline script block", async () => {
  const html = await readFile(join(process.cwd(), "web", "index.html"), "utf8");
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
});
