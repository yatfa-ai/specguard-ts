import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const { join, dirname } = path;

import { annotateRows, ANNOTATION_LOOKBACK_LINES } from "../src/node-test/annotate.js";
import type { SpecRow } from "../src/core/types.js";
import { SCHEMA_CONTRACT_DIGEST, VALIDATE_INTENT_ENV_VAR } from "../src/core/validator.js";

const GOOD = SCHEMA_CONTRACT_DIGEST;
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..", "..");
const annotatedFixture = join(pkgRoot, "fixtures", "annotated.test.js");
const fixtureText = fs.readFileSync(annotatedFixture, "utf8").split("\n");

/**
 * Locate the 1-based line of a source line by prefix — keeps this test honest
 * about REAL line numbers instead of restating magic integers twice.
 */
function lineOf(prefix: string): number {
  const index = fixtureText.findIndex((l) => l.startsWith(prefix));
  assert.ok(index >= 0, `fixture lost its ${prefix} line`);
  return index + 1;
}

const L_APPLY = lineOf('test("applies a valid promo code"');
const L_REJECT = lineOf('test("rejects an expired promo code"');
const L_BARE = lineOf('test("has no annotation above it"');
const L_APPLY_COMMENT = lineOf('// @intent: {"entity":"Cart","action":"apply promo code","behavior":"applies the discount');
const L_REJECT_COMMENT = lineOf('// @intent: {"entity":"Cart","action":"apply promo code","behavior":"rejects an expired code');

function row(file: string, line: number, name: string): SpecRow {
  return {
    file_path: file,
    line_number: line,
    status: "unannotated",
    intent: null,
    name,
    duration: null,
    id: `${file}:${line}`,
    outcome: "passed",
  };
}

/** The measured offset: the annotation comment sits one line above the test. */
test("fixture layout pins the comment-above-test offset at exactly one line", () => {
  assert.equal(L_APPLY - L_APPLY_COMMENT, 1);
  assert.equal(L_REJECT - L_REJECT_COMMENT, 1);
  assert.equal(ANNOTATION_LOOKBACK_LINES, 1);
});

function stubBackend(findings: unknown[], annotations: number, exit = 0): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specguard-validator-"));
  const file = path.join(dir, "validate-intent");
  const document = JSON.stringify({ mode: "source", findings, summary: { annotations } });
  fs.writeFileSync(
    file,
    [
      "#!/bin/sh",
      "case \"$1\" in",
      "  --version) printf '%s\\n' 'validate-intent stub (test) schema sha256:" + GOOD + "'; exit 0 ;;",
      "  --schema-source) printf '%s\\n' 'schema <embedded schema> sha256:" + GOOD + "'; exit 0 ;;",
      "esac",
      "if [ \"$1\" = \"--source\" ]; then",
      `  printf '%s\\n' '${document.replace(/'/g, `'\\''`)}'`,
      `  exit ${exit}`,
      "fi",
      "exit 0",
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
  return file;
}

const INTENT_APPLY = {
  entity: "Cart",
  action: "apply promo code",
  behavior: "applies the discount when the code is valid",
  layer: "unit",
};
const INTENT_REJECT = {
  entity: "Cart",
  action: "apply promo code",
  behavior: "rejects an expired code with a user-facing error",
  layer: "unit",
};

/** Findings keyed exactly as a real binary reports: the COMMENT's line. */
function passingFindings(): unknown[] {
  return [
    {
      file: "fixtures/annotated.test.js",
      line: L_APPLY_COMMENT,
      kind: "schema",
      ok: true,
      errors: [],
      intent: INTENT_APPLY,
    },
    {
      file: "fixtures/annotated.test.js",
      line: L_REJECT_COMMENT,
      kind: "schema",
      ok: true,
      errors: [],
      intent: INTENT_REJECT,
    },
  ];
}

const rows = () => [
  row("fixtures/annotated.test.js", L_APPLY, "applies a valid promo code"),
  row("fixtures/annotated.test.js", L_REJECT, "rejects an expired promo code"),
  row("fixtures/annotated.test.js", L_BARE, "has no annotation above it"),
];

test("passing findings map onto rows by (file, comment-line): annotated status + intent VERBATIM", () => {
  const binary = stubBackend(passingFindings(), 2);
  const warnings: string[] = [];
  const out = annotateRows(rows(), {
    repoRoot: pkgRoot,
    env: { [VALIDATE_INTENT_ENV_VAR]: binary },
    warn: (m) => warnings.push(m),
  });
  assert.deepEqual(warnings, []);
  assert.equal(out.annotated, 2);
  assert.equal(out.rows[0]!.status, "annotated");
  assert.deepEqual(out.rows[0]!.intent, INTENT_APPLY); // verbatim, guard against silent-drop
  assert.equal(out.rows[1]!.status, "annotated");
  assert.deepEqual(out.rows[1]!.intent, INTENT_REJECT);
  assert.equal(out.rows[2]!.status, "unannotated");
  assert.equal(out.rows[2]!.intent, null);
});

test("GUARD against the v0.1.3 silent-drop shape: the mapping reads the finding's `intent` key", () => {
  // A stub shaped like v0.1.3 — findings pass but carry NO intent key. The
  // rows still flip to annotated (the annotation exists and is valid) but
  // carry intent null; the guard this test pins is that when the key IS
  // present it must reach the row — see the test above. Here we pin the
  // degraded-but-honest shape so the two are distinguishable on telemetry.
  const dropped = passingFindings().map((f) => {
    const { intent: _drop, ...rest } = f as Record<string, unknown>;
    return rest;
  });
  const binary = stubBackend(dropped, 2);
  const out = annotateRows(rows(), {
    repoRoot: pkgRoot,
    env: { [VALIDATE_INTENT_ENV_VAR]: binary },
    warn: () => {},
  });
  assert.equal(out.rows[0]!.status, "annotated");
  assert.equal(out.rows[0]!.intent, null);
});

test("ok:false findings map to NO row — malformed annotations are the lint command's product", () => {
  const findings = [
    {
      file: "fixtures/annotated.test.js",
      line: L_APPLY_COMMENT,
      kind: "schema",
      ok: false,
      errors: ["entity: is missing"],
      intent: INTENT_APPLY,
    },
    ...passingFindings().slice(1),
  ];
  const binary = stubBackend(findings, 2, 1);
  const warnings: string[] = [];
  const out = annotateRows(rows(), {
    repoRoot: pkgRoot,
    env: { [VALIDATE_INTENT_ENV_VAR]: binary },
    warn: (m) => warnings.push(m),
  });
  // Exit 1 from the binary is a verdict, not a backend failure: rows for the
  // failing site stay unannotated, the passing one maps, and NOTHING warns
  // per-site.
  assert.deepEqual(warnings, []);
  assert.equal(out.rows[0]!.status, "unannotated");
  assert.equal(out.rows[0]!.intent, null);
  assert.equal(out.rows[1]!.status, "annotated");
});

test("never-fail: binary absent ⇒ slice-1 rows byte-identical, exactly one warning", () => {
  const warnings: string[] = [];
  const input = rows();
  const out = annotateRows(input, { repoRoot: pkgRoot, env: {}, warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /validator backend could not be resolved/);
  assert.match(warnings[0]!, /test run is unaffected/);
  assert.ok(out.degraded);
  assert.deepEqual(out.rows, input); // untouched, field for field
});

test("never-fail: backend error ⇒ slice-1 rows, one warning", () => {
  // A stub that answers the probes with the contract digest but writes
  // garbage for --source.
  const binary = stubBackend([], 0, 0);
  const dir = path.dirname(binary);
  fs.writeFileSync(
    binary,
    [
      "#!/bin/sh",
      "case \"$1\" in",
      "  --version) printf '%s\\n' 'validate-intent stub schema sha256:" + GOOD + "'; exit 0 ;;",
      "  --schema-source) printf '%s\\n' 'schema <embedded schema> sha256:" + GOOD + "'; exit 0 ;;",
      "esac",
      "printf 'not json at all\\n'",
      "exit 0",
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
  void dir;
  const warnings: string[] = [];
  const input = rows();
  const out = annotateRows(input, {
    repoRoot: pkgRoot,
    env: { [VALIDATE_INTENT_ENV_VAR]: binary },
    warn: (m) => warnings.push(m),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /validator backend failed/);
  assert.deepEqual(out.rows, input);
});

test("annotation-free repository needs no binary: rows untouched, no warning", () => {
  // A repo root with the fixture but the fixture is not scanned here: use a
  // temp root containing only a token-free test file — the token gate must
  // return before any binary resolution.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "specguard-annotate-"));
  fs.writeFileSync(path.join(root, "bare.test.js"), 'import { test } from "node:test";\ntest("x", () => {});\n');
  const warnings: string[] = [];
  const input = [row("bare.test.js", 2, "x")];
  const out = annotateRows(input, { repoRoot: root, env: {}, warn: (m) => warnings.push(m) });
  assert.deepEqual(warnings, []);
  assert.deepEqual(out.rows, input);
  assert.equal(out.annotated, 0);
  assert.ok(!out.degraded);
});

test("a row whose line - lookback lands on a non-annotation line stays unannotated", () => {
  // The bare test's line-1 lookback points at a blank line, not a finding.
  const binary = stubBackend(passingFindings(), 2);
  const out = annotateRows(
    [row("fixtures/annotated.test.js", L_BARE, "has no annotation above it")],
    { repoRoot: pkgRoot, env: { [VALIDATE_INTENT_ENV_VAR]: binary }, warn: () => {} },
  );
  assert.equal(out.annotated, 0);
  assert.equal(out.rows[0]!.status, "unannotated");
});

test("absolute finding paths normalize to the row's repo-relative coordinate", () => {
  const findings = passingFindings().map((f) => ({
    ...(f as Record<string, unknown>),
    file: join(pkgRoot, "fixtures", "annotated.test.js"),
  }));
  const binary = stubBackend(findings, 2);
  const out = annotateRows(rows(), {
    repoRoot: pkgRoot,
    env: { [VALIDATE_INTENT_ENV_VAR]: binary },
    warn: () => {},
  });
  assert.equal(out.annotated, 2);
});
