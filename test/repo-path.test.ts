import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { repoRelativePosix } from "../src/core/repo-path.js";

const root = path.resolve("/repo/root");

test("repoRelativePosix: an absolute path inside the root becomes root-relative with posix separators", () => {
  assert.equal(repoRelativePosix(path.join(root, "src", "a.test.ts"), root), "src/a.test.ts");
  assert.equal(repoRelativePosix(path.join(root, "a.test.ts"), root), "a.test.ts");
});

test("repoRelativePosix: an absolute path outside the root is returned verbatim, never a ../ escape", () => {
  const outside = path.resolve("/elsewhere/x.test.ts");
  assert.equal(repoRelativePosix(outside, root), outside);
  // A sibling sharing the root's name prefix is still outside it.
  const sibling = path.resolve("/repo/root-other/x.test.ts");
  assert.equal(repoRelativePosix(sibling, root), sibling);
});

test("repoRelativePosix: a non-absolute path only gets the separator fold, with no ./ or ../ folding", () => {
  assert.equal(repoRelativePosix(["src", "a.test.ts"].join(path.sep), root), "src/a.test.ts");
  assert.equal(repoRelativePosix("./a.test.ts", root), "./a.test.ts");
  assert.equal(repoRelativePosix("../a.test.ts", root), "../a.test.ts");
});
