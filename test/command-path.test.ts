import assert from "node:assert/strict";
import { delimiter } from "node:path";
import test from "node:test";
import { applyCommandPath } from "../src/command-path.js";

const policy = {
  userBinDir: "/user/bin",
  repoBinDir: "/repo/bin",
};

test("applyCommandPath pins user and repo bins before the existing PATH", () => {
  const input = ["/a", policy.repoBinDir, "/b", policy.userBinDir, "/c"].join(delimiter);
  const result = applyCommandPath({ PATH: input }, policy);

  assert.equal(
    result.PATH,
    [policy.userBinDir, policy.repoBinDir, "/a", "/b", "/c"].join(delimiter),
  );
});

test("applyCommandPath is idempotent", () => {
  const once = applyCommandPath({ PATH: ["/a", "/b"].join(delimiter) }, policy);
  const twice = applyCommandPath(once, policy);

  assert.deepEqual(twice, once);
});
