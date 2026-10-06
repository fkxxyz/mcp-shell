import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { StdioLspConnection } from "../src/lsp/connection.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "fake-lsp-server.mjs");

test("stdio LSP connection can issue a request immediately after start", async () => {
  const connection = new StdioLspConnection({
    cwd: process.cwd(),
    env: process.env,
    executable: process.execPath,
    args: [fixture],
  }, 1_000);

  try {
    await connection.start();
    const result = await connection.sendRequest<{ method: string; params: unknown }>("probe", {
      value: 42,
    });
    assert.deepEqual(result, {
      method: "probe",
      params: { value: 42 },
    });
  } finally {
    await connection.close();
  }
});

test("stdio LSP connection rejects pending work when the server exits", async () => {
  const connection = new StdioLspConnection({
    cwd: process.cwd(),
    env: process.env,
    executable: process.execPath,
    args: [fixture, "--exit-immediately"],
  }, 1_000);

  await connection.start();
  await assert.rejects(
    connection.sendRequest("probe"),
    /LSP server (exited|connection closed)/,
  );
  await connection.close();
});
