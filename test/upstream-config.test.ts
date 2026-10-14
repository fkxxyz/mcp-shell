import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadUpstreamConfig, DEFAULT_UPSTREAM_TIMEOUT_MS } from "../src/upstream/config.js";

async function withFile(content: string | null, run: (file: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shell-upstreams-"));
  const file = join(dir, "upstreams.yaml");
  try {
    if (content !== null) {
      await writeFile(file, content, { mode: 0o600 });
      await chmod(file, 0o600);
    }
    await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const self = { port: 3000, publicBaseUrl: "https://mcp.example.test" };

test("missing upstreams file means no upstreams", async () => {
  await withFile(null, async (file) => {
    const config = await loadUpstreamConfig(file, self);
    assert.deepEqual(config, { timeoutMs: DEFAULT_UPSTREAM_TIMEOUT_MS, upstreams: [] });
  });
});

test("loads named upstreams with a global timeout", async () => {
  await withFile([
    "version: 1",
    "timeoutMs: 5000",
    "upstreams:",
    "  - name: docs",
    "    url: http://127.0.0.1:9100/mcp",
    "  - name: remote",
    "    url: https://tools.example.test/mcp",
  ].join("\n"), async (file) => {
    const config = await loadUpstreamConfig(file, self);
    assert.equal(config.timeoutMs, 5000);
    assert.deepEqual(config.upstreams.map((u) => [u.name, u.url.href]), [
      ["docs", "http://127.0.0.1:9100/mcp"],
      ["remote", "https://tools.example.test/mcp"],
    ]);
  });
});

test("rejects unknown keys, bad schemes, credentials, duplicate names, and self-reference", async () => {
  const cases: Array<[string, RegExp]> = [
    ["version: 1\nupstreams:\n  - name: a\n    url: http://10.0.0.5/mcp\n    timeout_ms: 1\n", /timeout_ms|Unrecognized/],
    ["version: 1\nupstreams:\n  - name: a\n    url: ftp://10.0.0.5/mcp\n", /must use http or https/],
    ["version: 1\nupstreams:\n  - name: a\n    url: http://user:pw@10.0.0.5/mcp\n", /must not contain credentials/],
    ["version: 1\nupstreams:\n  - name: a\n    url: http://10.0.0.5/x\n  - name: a\n    url: http://10.0.0.6/x\n", /duplicate upstream name "a"/],
    ["version: 1\nupstreams:\n  - name: me\n    url: http://127.0.0.1:3000/mcp\n", /points at this mcp-shell instance/],
    ["version: 1\nupstreams:\n  - name: me\n    url: https://mcp.example.test/mcp\n", /points at this mcp-shell instance/],
    ["version: 2\nupstreams: []\n", /version/],
  ];
  for (const [content, pattern] of cases) {
    await withFile(content, async (file) => {
      await assert.rejects(loadUpstreamConfig(file, self), pattern, content);
    });
  }
});

test("rejects an upstream file readable by other users", async () => {
  await withFile("version: 1\nupstreams: []\n", async (file) => {
    await chmod(file, 0o644);
    await assert.rejects(loadUpstreamConfig(file, self), /must have mode 0600/);
  });
});
