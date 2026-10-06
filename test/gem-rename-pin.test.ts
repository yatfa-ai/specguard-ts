import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Seal for SPGD-1617: the Ruby client gem was renamed `specguard-rspec` ->
// `specguard-ruby` (the old gem name is yanked: rubygems.org answers 404 for
// it). README.md:10 and nine src comments still named the old gem. The
// absence assertion is the point — nothing else would notice the old name
// creeping back into a mirrored-from-Ruby comment.
//
// The compiled test runs from .test-build/test/, so the package root is two
// levels up (the house README-seal pattern, test/readme-intent-claims.test.ts).
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const OLD_NAME = "specguard-rspec";
const MESSAGE =
  `the old Ruby gem name "${OLD_NAME}" is back — the gem was renamed ` +
  'and the old name yanked; the Ruby client is now "specguard-ruby" (SPGD-1617)';

const tsFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? tsFiles(full) : full.endsWith(".ts") ? [full] : [];
  });

test("SPGD-1617: README.md no longer names the yanked specguard-rspec gem", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  assert.ok(!readme.includes(OLD_NAME), `README.md: ${MESSAGE}`);
});

test("SPGD-1617: no src/**/*.ts file names the yanked specguard-rspec gem", () => {
  const files = tsFiles(join(root, "src"));
  assert.ok(files.length > 0, "found no src/**/*.ts files — the pin's path is wrong");
  for (const file of files) {
    assert.ok(
      !readFileSync(file, "utf8").includes(OLD_NAME),
      `${relative(root, file)}: ${MESSAGE}`,
    );
  }
});
