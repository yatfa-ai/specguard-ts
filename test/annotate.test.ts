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
import { SCAN_MAX_BYTES } from "../src/lint/discover.js";

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

/** Findings keyed exactly as a real binary reports: the COMMENT's line.
 * Passing findings carry `kind: null` — the REAL binary's documented shape
 * (report.go: "`kind` is null on a passing finding"). */
function passingFindings(): unknown[] {
  return [
    {
      file: "fixtures/annotated.test.js",
      line: L_APPLY_COMMENT,
      kind: null,
      ok: true,
      errors: [],
      intent: INTENT_APPLY,
    },
    {
      file: "fixtures/annotated.test.js",
      line: L_REJECT_COMMENT,
      kind: null,
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

test("TOLERANCE (forward-compat): the one legacy string-kind PASSING fixture still annotates", () => {
  // The real binary emits `kind: null` on passing findings and every fixture
  // above encodes that shape. A binary that instead names a kind on a PASSING
  // finding (the pre-fix stubs' skew) is TOLERATED — the same tolerance
  // family as the v0.1.3 no-intent guard above: an old binary must degrade
  // telemetry, never break the run. This is the tree's ONLY deliberately
  // skewed passing fixture.
  const legacy = passingFindings().map((f) => ({ ...(f as Record<string, unknown>), kind: "schema" }));
  const binary = stubBackend(legacy, 2);
  const warnings: string[] = [];
  const out = annotateRows(rows(), {
    repoRoot: pkgRoot,
    env: { [VALIDATE_INTENT_ENV_VAR]: binary },
    warn: (m) => warnings.push(m),
  });
  assert.deepEqual(warnings, []);
  assert.equal(out.annotated, 2);
  assert.equal(out.rows[0]!.status, "annotated");
  assert.deepEqual(out.rows[0]!.intent, INTENT_APPLY);
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

// ---------------------------------------------------------------------------
// SPGD-929: the token gate consults `unscannable` — a file the scan could not
// look at (unreadable, or over SCAN_MAX_BYTES) is "could not look", never
// "nothing to check", so that arm degrades loudly: degraded:true plus exactly
// ONE warning naming the file(s), rows untouched. The never-fail guarantee
// stands: no throw, no exit code, rows byte-identical on every arm below.
// ---------------------------------------------------------------------------

/** chmod 000 is a genuine unreadable fixture only under a non-root uid. */
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

/** A token-bearing line — the unit the oversized fixture is built from. */
const oversizeLine = `// @intent: ${"x".repeat(64)}\n`; // 77 bytes, carries the token

test(
  "never-fail: annotated file over SCAN_MAX_BYTES ⇒ degraded, exactly one warning naming it",
  () => {
    // The UNCONDITIONAL guard (no privileges needed in any environment, never
    // skipped): the file carries `@intent:` tokens but exceeds SCAN_MAX_BYTES,
    // so scanTokens flags it unscannable — the gate must say "could not look",
    // not launder it into "nothing to check" with degraded:false.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specguard-annotate-"));
    const big = path.join(root, "big.test.js");
    fs.writeFileSync(big, oversizeLine.repeat(Math.ceil((SCAN_MAX_BYTES + 1024) / oversizeLine.length)));
    assert.ok(fs.statSync(big).size > SCAN_MAX_BYTES); // pin the fixture's premise
    const warnings: string[] = [];
    const input = [row("big.test.js", 2, "x")];
    const out = annotateRows(input, { repoRoot: root, env: {}, warn: (m) => warnings.push(m) });
    assert.equal(out.annotated, 0);
    assert.equal(out.degraded, true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /could not be scanned/);
    assert.match(warnings[0]!, new RegExp(`larger than ${SCAN_MAX_BYTES} bytes`));
    assert.ok(warnings[0]!.includes(big)); // names the file
    assert.match(warnings[0]!, /test run is unaffected/);
    assert.deepEqual(out.rows, input); // rows untouched on the new arm
  },
);

test(
  "never-fail: unreadable annotated file ⇒ degraded, exactly one warning naming it",
  // ONLY this arm yields under root (root reads through permission bits, so
  // chmod 000 would not be a real fixture there); the oversized guard above
  // is unconditional everywhere.
  { skip: isRoot ? "running as root: chmod 000 is not a real unreadable fixture" : false },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specguard-annotate-"));
    const locked = path.join(root, "locked.test.js");
    fs.writeFileSync(
      locked,
      '// @intent: {"entity":"Cart","action":"x","behavior":"y"}\ntest("x", () => {});\n',
    );
    fs.chmodSync(locked, 0o000);
    const warnings: string[] = [];
    const input = [row("locked.test.js", 2, "x")];
    const out = annotateRows(input, { repoRoot: root, env: {}, warn: (m) => warnings.push(m) });
    assert.equal(out.annotated, 0);
    assert.equal(out.degraded, true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /could not be scanned/);
    assert.ok(warnings[0]!.includes(locked)); // names the file
    assert.match(warnings[0]!, /test run is unaffected/);
    assert.deepEqual(out.rows, input);
  },
);

test(
  "tokens exist beside an unscannable file ⇒ exactly ONE warning, and it names the unscannable file",
  () => {
    // The no-double-warning property, rewritten by SPGD-971: with tokens on
    // the readable file the pass reaches the backend-unresolvable arm, and
    // the ONE line it emits must still name the file the scan could not look
    // at — the old `could not be scanned`-less line was the defect (the
    // unscannable file was carried past the token gate and dropped there).
    // Unconditional: oversized fixture, no binary, no privileges.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specguard-annotate-"));
    const big = path.join(root, "big.test.js");
    fs.writeFileSync(big, oversizeLine.repeat(Math.ceil((SCAN_MAX_BYTES + 1024) / oversizeLine.length)));
    fs.writeFileSync(
      path.join(root, "annotated.test.js"),
      '// @intent: {"entity":"Cart","action":"x","behavior":"y"}\ntest("x", () => {});\n',
    );
    const warnings: string[] = [];
    const input = [row("annotated.test.js", 2, "x")];
    const out = annotateRows(input, { repoRoot: root, env: {}, warn: (m) => warnings.push(m) });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /could not be scanned/);
    assert.ok(warnings[0]!.includes(big)); // names the unscannable file
    assert.match(warnings[0]!, /validator backend could not be resolved/); // backend fact kept on the same line
    assert.equal(out.degraded, true);
    assert.deepEqual(out.rows, input);
  },
);

test(
  "SPGD-971: a kind:read failure beside a passing finding degrades loudly — one warning naming it, mapping unchanged",
  () => {
    // The binary DID report the read failure — annotateRows discarded it at
    // the row-mapping loop's first `continue` (a read finding carries
    // ok:false) and reported degraded:false with zero warnings. The failure
    // must be COUNTED before the loop skips it: degraded:true, exactly one
    // warning naming the file — while the passing finding still annotates
    // its row exactly as before (only `degraded` and the warning move).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specguard-annotate-"));
    fs.writeFileSync(
      path.join(root, "good.test.js"),
      '// @intent: {"entity":"Cart","action":"x","behavior":"y"}\ntest("x", () => {});\n',
    );
    const binary = stubBackend(
      [
        { file: "good.test.js", line: 1, kind: null, ok: true, errors: [], intent: INTENT_APPLY },
        {
          file: "vanish.test.js",
          line: null,
          kind: "read",
          ok: false,
          errors: ["open vanish.test.js: no such file or directory"],
          intent: null,
        },
      ],
      1, // summary.annotations: only the read finding is file-shaped, not a site
    );
    const warnings: string[] = [];
    const input = [row("good.test.js", 2, "x"), row("vanish.test.js", 2, "y")];
    const out = annotateRows(input, {
      repoRoot: root,
      env: { [VALIDATE_INTENT_ENV_VAR]: binary },
      warn: (m) => warnings.push(m),
    });
    assert.equal(out.degraded, true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /could not be scanned/);
    assert.ok(warnings[0]!.includes("vanish.test.js")); // names the read-failed file
    assert.match(warnings[0]!, /test run is unaffected/);
    // This arm is the one site where the backend succeeded and rows DO
    // annotate (out.annotated === 1 below) — the warning must therefore NOT
    // carry the sibling arms' "telemetry ships unannotated" tail, which is
    // true only where annotated: 0 is returned. Pin both halves of the claim.
    assert.ok(!warnings[0]!.includes("telemetry ships unannotated"));
    assert.match(warnings[0]!, /those files ship unannotated/);
    // The never-fail mapping is untouched: the passing finding annotates,
    // the read-failed file's row is byte-identical to its input.
    assert.equal(out.annotated, 1);
    assert.equal(out.rows[0]!.status, "annotated");
    assert.deepEqual(out.rows[0]!.intent, INTENT_APPLY);
    assert.deepEqual(out.rows[1], input[1]);
  },
);

test(
  "SPGD-971: a file both unscannable and read-failed is named exactly ONCE, in one warning",
  () => {
    // Criterion: the two sources (discovery's `unscannable`, the binary's
    // read findings) fold into ONE de-duplicated line — the oversized file
    // below is unscannable at discovery AND reported kind:read by the stub
    // backend, so a naive concatenation would name it twice.
    // MIXED SHAPE, deliberately: discovery names files absolutely
    // (path.join(root, …)) while a real backend echoes whatever it was
    // handed — here a relative "big.test.js". Dedup keys on the NORMALIZED
    // path for exactly this case; keying on the raw string would name the
    // file twice ("…: /tmp/…/big.test.js, big.test.js") and this example
    // would catch it via the occurrence count below.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specguard-annotate-"));
    const big = path.join(root, "big.test.js");
    fs.writeFileSync(big, oversizeLine.repeat(Math.ceil((SCAN_MAX_BYTES + 1024) / oversizeLine.length)));
    fs.writeFileSync(
      path.join(root, "good.test.js"),
      '// @intent: {"entity":"Cart","action":"x","behavior":"y"}\ntest("x", () => {});\n',
    );
    const binary = stubBackend(
      [
        { file: "big.test.js", line: null, kind: "read", ok: false, errors: ["read big.test.js: too large"], intent: null },
        { file: "good.test.js", line: 1, kind: null, ok: true, errors: [], intent: INTENT_APPLY },
      ],
      1,
    );
    const warnings: string[] = [];
    const input = [row("good.test.js", 2, "x")];
    const out = annotateRows(input, {
      repoRoot: root,
      env: { [VALIDATE_INTENT_ENV_VAR]: binary },
      warn: (m) => warnings.push(m),
    });
    assert.equal(out.degraded, true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /could not be scanned/);
    assert.match(warnings[0]!, /1 file\(s\)/); // the union collapsed to one name
    assert.equal(warnings[0]!.split("big.test.js").length - 1, 1); // named exactly once
    // No assertion on WHICH spelling survives — that is call-order detail
    // owned by the fold sites (#11 owns the discovery side, the read test
    // above owns the binary side). This example's contract is exactly-once
    // under mixed spellings; it must not double as a discovery-fold detector.
    assert.equal(out.annotated, 1); // the readable finding still maps
  },
);

test(
  "SPGD-1006: an oversize file the backend ratified is not named as shipping unannotated, and its rows annotate",
  () => {
    // The criterion that FAILS on origin/main (90db6f6): a >4 MB readable,
    // validly annotated file was discovery-unscannable (the token-scan
    // budget) yet backend-annotated in the SAME pass — and the ships-
    // unannotated warning named it besides. Both halves are pinned in one
    // pass. The gate needs a token from somewhere to reach the backend, so
    // a small readable token-bearer rides along (the SPGD-971 mixed
    // fixture's shape).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specguard-annotate-"));
    const big = path.join(root, "big.test.js");
    const bigAnnotation = '// @intent: {"entity":"Cart","action":"x","behavior":"y"}\n';
    const filler = "// filler line\n";
    fs.writeFileSync(
      big,
      bigAnnotation + filler.repeat(Math.ceil((SCAN_MAX_BYTES + 1024) / filler.length)),
    );
    assert.ok(fs.statSync(big).size > SCAN_MAX_BYTES); // pin the fixture's premise
    fs.writeFileSync(
      path.join(root, "good.test.js"),
      '// @intent: {"entity":"Cart","action":"x","behavior":"z"}\ntest("y", () => {});\n',
    );
    // The binary reads big.test.js FINE (no size cap binary-side) and
    // returns a PASSING finding for its line-1 annotation — the exact
    // finding the old warning falsely claimed could not exist.
    const binary = stubBackend(
      [
        { file: "big.test.js", line: 1, kind: null, ok: true, errors: [], intent: INTENT_APPLY },
        { file: "good.test.js", line: 1, kind: null, ok: true, errors: [], intent: INTENT_REJECT },
      ],
      2,
    );
    const warnings: string[] = [];
    const input = [row("big.test.js", 2, "x"), row("good.test.js", 2, "y")];
    const out = annotateRows(input, {
      repoRoot: root,
      env: { [VALIDATE_INTENT_ENV_VAR]: binary },
      warn: (m) => warnings.push(m),
    });
    // Half 1 — the rows: the oversize file's row annotates, intent verbatim.
    assert.equal(out.annotated, 2);
    assert.equal(out.rows[0]!.status, "annotated");
    assert.deepEqual(out.rows[0]!.intent, INTENT_APPLY);
    assert.equal(out.rows[1]!.status, "annotated");
    assert.deepEqual(out.rows[1]!.intent, INTENT_REJECT);
    // Half 2 — the naming: NO warning at all. The pass has nothing degraded
    // to say about a file it fully annotated: it is not named as shipping
    // unannotated, and the pass does not degrade.
    assert.deepEqual(warnings, []);
    assert.equal(out.degraded, false);
  },
);

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

// ---------------------------------------------------------------------------
// SPGD-1011: the ROW leg of the join is normalized like the finding leg.
// The coordinate join is spelled twice inside annotateRows — SPGD-971 put
// the finding key through `normalizeRepoPath` and left the row key RAW ten
// lines below. On Windows every node:path helper (relative, isAbsolute,
// sep) yields backslash spellings, so the raw row key
// (`a\special\login.test.ts:41`) can never equal the normalized finding key
// (`a/special/login.test.ts:41`): every annotated row silently launders to
// "unannotated", `annotated: 0`, no warning — the POST succeeds and the
// platform reads the run as a suite of dark tests. The same raw key also
// misses whenever the row's spelling differs from discovery's (absolute
// pass-through), even on POSIX.
// ---------------------------------------------------------------------------

test(
  "SPGD-1011: every row-side spelling re-derives to the finding key the map already holds (absolute included)",
  () => {
    // The map invariant, behaviorally: whatever spelling a row's file_path
    // carries, the key looked up in `byCoordinate` must be the same one the
    // finding leg filed — the mapping may not represent one coordinate in
    // two spellings. The ABSOLUTE spelling is the discriminator (discovery
    // names files with path.join; the pre-fix raw row key could not meet
    // the normalized map), and it discriminates on every platform; the
    // forward-slash arm is the byte-identical pin — normalization must be
    // the identity it always was on the spelling that already joined.
    for (const spelling of ["fixtures/annotated.test.js", join(pkgRoot, "fixtures", "annotated.test.js")]) {
      const warnings: string[] = [];
      const binary = stubBackend(passingFindings().slice(0, 1), 1);
      const out = annotateRows([row(spelling, L_APPLY, "applies a valid promo code")], {
        repoRoot: pkgRoot,
        env: { [VALIDATE_INTENT_ENV_VAR]: binary },
        warn: (m) => warnings.push(m),
      });
      assert.deepEqual(warnings, []);
      assert.equal(out.annotated, 1, `row spelling ${spelling} must join the normalized finding key`);
      assert.equal(out.rows[0]!.status, "annotated");
      assert.deepEqual(out.rows[0]!.intent, INTENT_APPLY); // verbatim
    }
  },
);

test(
  "SPGD-1011: a backslash-spelled row annotates against the posix-spelled finding key (win32)",
  // The Windows failure mode, pinned: the collector may hand the row a
  // backslash spelling while the finding leg keys posix. On POSIX a
  // backslash is a legal filename character and node:path leaves it
  // verbatim — the same literal cannot fold there, so this fixture is a
  // REAL test only where sep is "\\" (the isRoot precedent above: a
  // fixture is honest only where its premise holds).
  {
    skip:
      process.platform === "win32"
        ? false
        : `backslash folding is win32 node:path behavior; on ${process.platform} a backslash path is a literal filename and cannot join a posix key`,
  },
  () => {
    const binary = stubBackend(passingFindings().slice(0, 1), 1);
    const warnings: string[] = [];
    const out = annotateRows([row("fixtures\\annotated.test.js", L_APPLY, "applies a valid promo code")], {
      repoRoot: pkgRoot,
      env: { [VALIDATE_INTENT_ENV_VAR]: binary },
      warn: (m) => warnings.push(m),
    });
    assert.deepEqual(warnings, []); // the join succeeds — nothing degrades
    assert.equal(out.annotated, 1);
    assert.equal(out.rows[0]!.status, "annotated");
    assert.deepEqual(out.rows[0]!.intent, INTENT_APPLY); // verbatim
  },
);

test(
  "SPGD-1011: an out-of-root row keeps its raw spelling and still joins the verbatim finding",
  () => {
    // Pass-through preserved: normalizeRepoPath hands an out-of-root path
    // back unchanged BY DESIGN (a nonsense ../ escape is never minted), so
    // an out-of-root coordinate joins when both legs carry the same
    // verbatim spelling — pre- and post-fix alike. This pins that the row
    // leg's normalization did not start rewriting paths the finding leg
    // echoes verbatim: over-normalize one leg and this join goes dark.
    const outside = join(os.tmpdir(), "specguard-1011-elsewhere", "out.test.ts");
    const binary = stubBackend(
      [{ file: outside, line: 1, kind: null, ok: true, errors: [], intent: INTENT_REJECT }],
      1,
    );
    const warnings: string[] = [];
    const out = annotateRows([row(outside, 2, "out-of-root example")], {
      repoRoot: pkgRoot,
      env: { [VALIDATE_INTENT_ENV_VAR]: binary },
      warn: (m) => warnings.push(m),
    });
    assert.deepEqual(warnings, []);
    assert.equal(out.annotated, 1);
    assert.equal(out.rows[0]!.status, "annotated");
    assert.deepEqual(out.rows[0]!.intent, INTENT_REJECT);
  },
);
