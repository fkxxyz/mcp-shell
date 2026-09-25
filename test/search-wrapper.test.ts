import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const repoBin = join(repoRoot, "bin");
const wrapper = join(repoBin, "_search-wrapper");

test("search wrapper terminates commands that exceed the 200ms budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-search-wrapper-"));
  const fake = join(dir, "fake-search");

  try {
    await writeFile(fake, "#!/bin/bash\necho partial-stdout\necho partial-stderr >&2\nsleep 2\n", "utf8");
    await chmod(fake, 0o755);

    const result = spawnSync(wrapper, ["fake-search"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: [repoBin, dir, "/usr/bin", "/bin"].join(delimiter),
      },
    });

    assert.equal(result.status, 124);
    assert.match(result.stdout, /partial-stdout/);
    assert.match(result.stderr, /partial-stderr/);
    assert.match(result.stderr, /MCP_SEARCH_TIMEOUT/);
    assert.match(result.stderr, /limit_ms=200/);
    assert.match(result.stderr, /report that the available information is insufficient/);
    assert.match(result.stderr, /rerun the command with --unsafe/);
    assert.match(result.stderr, /rg --unsafe/);
    assert.match(result.stderr, /reason=search_time_budget_exceeded/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("search wrapper strips --unsafe and bypasses the time budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-search-wrapper-"));
  const fake = join(dir, "fake-search");

  try {
    await writeFile(fake, "#!/bin/bash\nprintf '%s\\n' \"$@\"\n", "utf8");
    await chmod(fake, 0o755);

    const result = spawnSync(wrapper, ["fake-search", "alpha", "--unsafe", "beta"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: [repoBin, dir, "/usr/bin", "/bin"].join(delimiter),
      },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "alpha\nbeta\n");
    assert.equal(result.stderr, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
