import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Seal for SPGD-1525: the README's two false "no @intent on telemetry" claims.
// Since dd571fa (SPGD-893) the annotation pass has carried validator-ratified
// intents on the telemetry path, but neither README sentence was updated —
// the headline scope statement still said the reporter "reads **no" `@intent:`
// annotations, and the wire-contract `status` row said every row is "always
// `\"unannotated\"` in this slice". Both are false: `annotateRows` flips a
// ratified, attributed annotation to `status: "annotated"` with the intent
// verbatim.
//
// The absence assertions are the point. `"annotated"`/`"unannotated"` appear
// in the unfixed README too, so a positive-only seal would pass over the
// defect — only asserting the false sentences' absence seals the regression.
//
// The compiled test runs from .test-build/test/, so the package root is two
// levels up (the house README-seal pattern, test/ingest-cli.test.ts).
const here = dirname(fileURLToPath(import.meta.url));
const readme = readFileSync(join(here, "..", "..", "README.md"), "utf8");
const flat = readme.replace(/\s+/g, " ");

const count = (needle: string): number => readme.split(needle).length - 1;

test("SPGD-1525: the README no longer claims the reporter reads no @intent annotations on the telemetry path", () => {
  // The headline scope statement (README top) — the exact fragment that made
  // the false claim, present in the unfixed README at the `reads **no` line.
  assert.ok(
    !readme.includes("reads **no"),
    'the false headline claim "The reporter reads **no @intent: annotations on the telemetry path" ' +
      "is back in README.md — annotateRows has flipped ratified annotations to status " +
      '"annotated" on the telemetry path since dd571fa (SPGD-893)',
  );
  // The wire-contract `status` row.
  assert.ok(
    !readme.includes('always `"unannotated"` in this slice'),
    'the false wire-contract rule "always \\"unannotated\\" in this slice" is back in README.md',
  );
});

test("SPGD-1525: the README states the true status rule and the two-arm attribution rule", () => {
  // Corrected headline: a ratified, attributed annotation ships annotated,
  // verbatim; a zero-annotation run stays valid and primary.
  assert.ok(
    flat.includes("carries `@intent:` annotations on the telemetry path"),
    "the corrected telemetry-path claim is gone from the README headline",
  );
  assert.ok(flat.includes('ships as `status: "annotated"`'));
  assert.ok(flat.includes("with the finding's intent object verbatim"));
  assert.ok(
    flat.includes("remains valid by construction"),
    "the zero-annotation run stays valid — that point must survive the rewrite",
  );

  // Corrected wire-contract `status` row.
  assert.ok(
    flat.includes('when a ratified `@intent:` is attributed to the test, otherwise `"unannotated"`'),
    "the wire-contract status rule no longer states when a row is annotated vs unannotated",
  );

  // The attribution rule, stated once: own line first, else the comment-only
  // line directly above; an unattributable annotation never fails the run.
  assert.ok(flat.includes("The test's own line first"));
  assert.ok(flat.includes("comment-only `// @intent:` line directly above"));
  assert.ok(flat.includes("never fails the run"));
  assert.equal(
    count("The test's own line first"),
    1,
    "the attribution rule is stated in exactly one place",
  );

  // Neither adapter section may again present the comment lookback as the
  // whole rule — the Vitest and Jest sections keep only the anchor-offset
  // fact and point at the single statement.
  assert.ok(
    !readme.includes("one-line comment lookback"),
    'an adapter section again presents the "one-line comment lookback" as the whole attribution rule',
  );
  assert.equal(
    count("[the reporter section](#how-an-annotation-is-attributed-to-a-test)"),
    2,
    "the Vitest and Jest sections must each point at the single attribution statement",
  );
});
