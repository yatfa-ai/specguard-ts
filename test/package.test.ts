import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("package.json declares ./node-test and ./vitest and no export for an adapter that does not exist", () => {
  const pkg = JSON.parse(
    readFileSync(join(pkgRoot, "package.json"), "utf8"),
  ) as {
    exports: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    dependencies?: Record<string, string>;
    bin?: Record<string, string>;
    description: string;
  };
  assert.ok(pkg.exports["."] !== undefined);
  assert.ok(pkg.exports["./node-test"] !== undefined);
  assert.equal(pkg.exports["./vitest"], "./dist/vitest/reporter.js",
    "the Vitest adapter is exported (slice 5)");
  assert.equal(pkg.exports["./jest"], undefined, "./jest is not implemented yet");
  assert.ok(pkg.bin !== undefined && pkg.bin["specguard"] !== undefined,
    "the specguard bin ships with slice 3 (specguard lint)");
  assert.equal(pkg.exports["./lint"], "./dist/lint/index.js",
    "the lint module is exported (slice 3)");
  assert.ok(pkg.bin["specguard"] === "./dist/cli.js", "bin points at the compiled CLI");
  assert.ok(pkg.bin["specguard-ingest"] === "./dist/ingest-cli.js",
    "the specguard-ingest replay bin ships with slice 6, as its own entry");
});

test("Vitest is an OPTIONAL peer, never a dependency — installable where no Vitest exists", () => {
  const pkg = JSON.parse(
    readFileSync(join(pkgRoot, "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
  // Never hard: no runtime dependency on Vitest in either direction.
  assert.equal(pkg.dependencies?.vitest, undefined, "vitest must not be a hard dependency");
  // Optional peer: npm must not auto-install Vitest into a node:test project.
  assert.equal(pkg.peerDependencies?.vitest, ">=4.0.0",
    "the Vitest adapter targets the Vitest 4 reporter API (onTestRunEnd)");
  assert.equal(pkg.peerDependenciesMeta?.vitest?.optional, true,
    "a node:test project installs this package with no Vitest present and no warning");
});

test("the description names the runners this package actually ships", () => {
  const pkg = JSON.parse(
    readFileSync(join(pkgRoot, "package.json"), "utf8"),
  ) as { description: string };
  assert.ok(pkg.description.includes("node:test"), pkg.description);
  assert.ok(pkg.description.includes("Vitest"), pkg.description);
});
