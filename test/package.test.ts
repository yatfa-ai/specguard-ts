import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("package.json declares ./node-test and declares no export or peerDependency for an adapter that does not exist", () => {
  const pkg = JSON.parse(
    readFileSync(join(pkgRoot, "package.json"), "utf8"),
  ) as {
    exports: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, unknown>;
    bin?: Record<string, string>;
    description: string;
  };
  assert.ok(pkg.exports["."] !== undefined);
  assert.ok(pkg.exports["./node-test"] !== undefined);
  assert.equal(pkg.exports["./vitest"], undefined, "./vitest is not implemented yet (slice 5)");
  assert.equal(pkg.exports["./jest"], undefined, "./jest is not implemented yet (slice 5)");
  assert.ok(pkg.bin !== undefined && pkg.bin["specguard"] !== undefined,
    "the specguard bin ships with slice 3 (specguard lint)");
  assert.equal(pkg.exports["./lint"], "./dist/lint/index.js",
    "the lint module is exported (slice 3)");
  assert.equal(pkg.peerDependencies, undefined, "no adapter peers exist to depend on");
  assert.equal(pkg.peerDependenciesMeta, undefined);
  assert.ok(!pkg.description.includes("Vitest"), pkg.description);
  assert.ok(!pkg.description.includes("Jest"), pkg.description);
  assert.ok(pkg.bin["specguard"] === "./dist/cli.js", "bin points at the compiled CLI");
});

test("the description names the runner this slice actually ships", () => {
  const pkg = JSON.parse(
    readFileSync(join(pkgRoot, "package.json"), "utf8"),
  ) as { description: string };
  assert.ok(pkg.description.includes("node:test"), pkg.description);
});
