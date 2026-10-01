import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { lint, EXIT_OK, EXIT_MALFORMED, EXIT_MISUSE } from "../src/lint/lint.js";
import { renderJson, renderHuman } from "../src/lint/report.js";
import { ownLineShadowFindingsInText } from "../src/lint/unreachable.js";
import {
  selectFiles,
  changedNameUnion,
  scanTokens,
  escapeGlob,
  LintUsageError,
  SCAN_MAX_BYTES,
} from "../src/lint/index.js";
import { SCHEMA_CONTRACT_DIGEST, VALIDATE_INTENT_ENV_VAR } from "../src/core/validator.js";
import { run as runCli } from "../src/cli.js";

const GOOD = SCHEMA_CONTRACT_DIGEST;

interface Fixture {
  root: string;
}

function makeRepo(files: Record<string, string>): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "specguard-lint-"));
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  return { root };
}

const GOOD_ANNOTATION =
  "// @intent: { entity: \"Order\", action: \"checkout\", behavior: \"returns 402 payment required on expired card\", layer: \"request\" }";
const BAD_ANNOTATION =
  "// @intent: { entiity: \"Order\", action: \"checkout\", behavior: \"returns 402 payment required on expired card\", layer: \"request\" }";

/**
 * A stub validate-intent binary answering the probe flags with the contract
 * digest, and `--source --json` with a fixed findings document. The document
 * shape mirrors the real binary (mode, findings, summary.annotations).
 */
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

function envWith(bin?: string, cwd?: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  if (bin !== undefined) env[VALIDATE_INTENT_ENV_VAR] = bin;
  if (cwd !== undefined) env["PWD"] = cwd;
  return env;
}

/**
 * A stub validate-intent binary that echoes what it was HANDED: each
 * `--source` pattern becomes a failing schema finding naming that pattern
 * verbatim (the same pass-through the real binary performs on
 * `finding.file`), so a pin asserting a relative name reads the register of
 * the paths lint actually passed to the binary, not a fabricated one. Same
 * probe contract as `stubBackend`.
 */
function echoingBackend(annotations: number, exit = 1): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specguard-validator-"));
  const file = path.join(dir, "validate-intent");
  fs.writeFileSync(
    file,
    [
      "#!/bin/sh",
      "case \"$1\" in",
      "  --version) printf '%s\\n' 'validate-intent stub (test) schema sha256:" + GOOD + "'; exit 0 ;;",
      "  --schema-source) printf '%s\\n' 'schema <embedded schema> sha256:" + GOOD + "'; exit 0 ;;",
      "esac",
      "if [ \"$1\" = \"--source\" ]; then",
      "  shift 2",
      "  printf '%s' '{\"mode\":\"source\",\"findings\":['",
      "  sep=''",
      "  for f in \"$@\"; do",
      "    printf '%s{\"file\":\"%s\",\"line\":1,\"kind\":\"schema\",\"ok\":false,\"errors\":[\"entity: is missing\"]}' \"$sep\" \"$f\"",
      "    sep=','",
      "  done",
      `  printf '%s],"summary":{"annotations":${annotations}}}'`,
      `  exit ${exit}`,
      "fi",
      "exit 0",
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
  return file;
}

function inRepo(
  fixture: Fixture,
  argv: string[],
  bin?: string,
  selectionOptions: { changed?: boolean; base?: string } = {},
) {
  const previous = process.cwd();
  process.chdir(fixture.root);
  try {
    return lint(argv, { env: envWith(bin), ...selectionOptions });
  } finally {
    process.chdir(previous);
  }
}

test("discovery walks only annotated extensions and skips dependency directories", () => {
  const f = makeRepo({
    "src/a.ts": GOOD_ANNOTATION,
    "src/b.jsx": GOOD_ANNOTATION,
    "src/ignore.txt": "@intent: prose",
    "node_modules/skip.js": GOOD_ANNOTATION,
    "dist/skip.js": GOOD_ANNOTATION,
  });
  const selection = selectFiles([], f.root);
  assert.equal(selection.mode, "walk");
  assert.deepEqual(
    selection.files.map((p) => path.relative(f.root, p)).sort(),
    ["src/a.ts", "src/b.jsx"],
  );
  const tokens = Object.fromEntries(
    scanTokens(selection.files).map((s) => [path.basename(s.file), s.tokens]),
  );
  assert.deepEqual(tokens, { "a.ts": 1, "b.jsx": 1 });
});

test("explicit selection refuses a non-annotated extension instead of silently skipping it", () => {
  assert.throws(() => selectFiles(["README.md"]), /not an annotated source file/);
});

/** Assert `fn` raises a `LintUsageError` carrying exactly `message`. */
function assertUsageError(fn: () => unknown, message: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof LintUsageError, `expected LintUsageError, got ${String(error)}`);
    assert.equal(error.message, message);
    return true;
  });
}

test("explicit selection refuses a DIRECTORY as a directory, not as a bad extension", () => {
  // `specguard lint src` is the likeliest user mistake, and the extension
  // sentence is false about it: `src` is not a source file of the wrong
  // suffix, it is a directory. `path.extname` of an ordinary directory is
  // `""`, so an extension-first order answers every directory with the
  // wrong remedy — the directory refusal has to be asked first.
  const f = makeRepo({ "src/a.ts": GOOD_ANNOTATION, "weird.ts/b.ts": GOOD_ANNOTATION });
  const previous = process.cwd();
  process.chdir(f.root);
  try {
    assertUsageError(
      () => selectFiles(["src"]),
      "src is a directory; name files or run without paths",
    );
    // A directory NAMED with an annotated extension was the only arm the
    // guard could reach before; it must keep reaching it.
    assertUsageError(
      () => selectFiles(["weird.ts"]),
      "weird.ts is a directory; name files or run without paths",
    );
  } finally {
    process.chdir(previous);
  }
});

test("a nonexistent named path is not a directory: the extension answer survives, and an annotated one still falls through", () => {
  // The statSync failure arm must FALL THROUGH to the extension guard, not
  // skip the iteration. Skipping would make `lint nonexistent.md` stop
  // being a usage error and quietly reach the binary instead.
  const f = makeRepo({ "src/a.ts": GOOD_ANNOTATION });
  const previous = process.cwd();
  process.chdir(f.root);
  try {
    assert.throws(
      () => selectFiles(["nonexistent.md"]),
      /nonexistent\.md is not an annotated source file \(/,
    );
    // An annotated extension that does not resolve is NOT a usage error —
    // it is selected as given and the read finding belongs to the binary.
    const selection = selectFiles(["nonexistent.ts"]);
    assert.equal(selection.mode, "explicit");
    assert.deepEqual(selection.files, ["nonexistent.ts"]);
  } finally {
    process.chdir(previous);
  }
});

test("the CLI exits 2 on a directory argument and says it is a directory", () => {
  const f = makeRepo({ "src/a.ts": GOOD_ANNOTATION });
  const cli = runCliInRepo(f, ["lint", "src"]);
  assert.equal(cli.exit, EXIT_MISUSE);
  assert.equal(cli.stdout, "");
  assert.match(
    cli.stderr,
    /specguard lint: error: src is a directory; name files or run without paths/,
  );
  assert.doesNotMatch(cli.stderr, /not an annotated source file/);
});

test("escapeGlob neutralizes glob metacharacters so a path matches only itself", () => {
  assert.equal(escapeGlob("spec/fixtures/bracket[1]_spec.js"), "spec/fixtures/bracket[[]1]_spec.js");
  assert.equal(escapeGlob("a*b?c.js"), "a[*]b[?]c.js");
});

test("clean annotated repo with a working binary exits 0 and reports both forms", () => {
  const f = makeRepo({ "a.test.ts": GOOD_ANNOTATION + "\nit('x', () => {});" });
  const binary = stubBackend(
    [{ file: "a.test.ts", line: 1, kind: null, ok: true, errors: [] }],
    1,
  );
  const report = inRepo(f, [], binary);
  assert.equal(report.exitCode, EXIT_OK);
  assert.ok(report.ok);
  assert.equal(report.summary.annotations, 1);
  assert.equal(report.summary.malformed, 0);
  const json = JSON.parse(renderJson(report));
  assert.equal(json.ok, true);
  assert.equal(json.mode, "source");
  assert.equal(json.summary.annotations, 1);
  assert.equal(json.findings[0]?.file, "a.test.ts");
  // Null-throughput: the document mirrors the binary's own finding shape —
  // a passing finding's kind renders as JSON null, not a string.
  assert.equal(json.findings[0]?.kind, null);
  const human = renderHuman(report);
  assert.match(human, /checked 1 source file/);
  assert.doesNotMatch(human, /FAIL/);
});

test("MALFORMED annotation case: a failing finding is exit 1, the only path to it", () => {
  const f = makeRepo({ "a.test.ts": BAD_ANNOTATION + "\nit('x', () => {});" });
  const binary = stubBackend(
    [
      {
        file: "a.test.ts",
        line: 1,
        kind: "schema",
        ok: false,
        errors: ["entity: is missing", "entiity: unknown field"],
      },
    ],
    1,
    1,
  );
  const report = inRepo(f, [], binary);
  assert.equal(report.exitCode, EXIT_MALFORMED);
  assert.ok(!report.ok);
  assert.equal(report.summary.malformed, 1);
  const human = renderHuman(report);
  assert.match(human, /FAIL a\.test\.ts:1 \(schema\)/);
  assert.match(human, /- entity: is missing/);
  const json = JSON.parse(renderJson(report)) as { ok: boolean; summary: { malformed: number } };
  assert.equal(json.ok, false);
  assert.equal(json.summary.malformed, 1);
});

// --- SPGD-1533: the walk register — findings are root-relative --------------
//
// The bare walk (`specguard lint` with no paths and no `--changed`) named
// every finding under an ABSOLUTE path — selectFiles' walk arm pushes
// `path.join(dir, entry.name)` seeded with the root lint() passes as
// process.cwd() — while explicit mode echoes the caller's spelling and
// `--changed` mode names files relative to the root. Both renderers copy
// `finding.file` verbatim, so one command shipped two path registers. These
// pins are the register pins: the expected names are written out LITERALLY,
// with no `path.relative(...)` normalization on either side — the three
// pre-existing selectFiles pins all normalize before comparing, and that
// normalization is exactly how the absolute register hid from them.

test("walk mode reports client-produced unreachable findings under root-relative paths", () => {
  const f = makeRepo({
    "src/stacked.test.js": [
      'import { test, describe } from "node:test";',
      "",
      STACKED_INTENT_A,
      STACKED_INTENT_B,
      'test("adds", () => {});',
    ].join("\n") + "\n",
  });
  const binary = stubBackend(
    [{ file: "src/stacked.test.js", line: 3, kind: null, ok: true, errors: [] }],
    1,
  );
  const report = inRepo(f, [], binary); // bare walk: no paths, no --changed
  assert.equal(report.exitCode, EXIT_MALFORMED);
  // The unreachable row is produced CLIENT-side (unreachable.ts) and
  // inherits `file` from the selection string, so its register IS the
  // selection's register. Literal comparison, deliberately un-normalized:
  // on the unfixed code this name arrives as an absolute tmp path and the
  // pin is red for exactly that reason.
  const unreachable = report.findings.filter((x) => x.kind === "unreachable");
  assert.equal(unreachable.length, 1);
  assert.equal(unreachable[0]?.file, "src/stacked.test.js");
  assert.equal(unreachable[0]?.line, 3);
  assert.ok(!unreachable[0]!.file.startsWith("/"), `absolute path leaked: ${unreachable[0]?.file}`);
  assert.ok(!unreachable[0]!.file.includes(f.root), `absolute path leaked: ${unreachable[0]?.file}`);
  const human = renderHuman(report);
  assert.match(human, /FAIL src\/stacked\.test\.js:3 \(unreachable\)/);
  const json = JSON.parse(renderJson(report)) as {
    findings: { file: string; kind: string }[];
  };
  assert.equal(
    json.findings.find((x) => x.kind === "unreachable")?.file,
    "src/stacked.test.js",
  );
});

test("walk mode reports binary-produced schema findings under root-relative paths", () => {
  const f = makeRepo({ "src/a.ts": GOOD_ANNOTATION, "src/b.ts": GOOD_ANNOTATION });
  // The echo stub mirrors what it was HANDED — each --source pattern becomes
  // a failing schema finding naming that pattern verbatim — so the findings
  // below read the register of the paths lint actually passed to the
  // binary, not a stub-fabricated name (which is how every other finding
  // assertion in this file was blind to the register).
  const binary = echoingBackend(2);
  const report = inRepo(f, [], binary); // bare walk
  assert.equal(report.exitCode, EXIT_MALFORMED);
  // Literal names, un-normalized on purpose (see the walk-register header).
  assert.deepEqual(
    report.findings.map((x) => x.file).sort(),
    ["src/a.ts", "src/b.ts"],
  );
  const human = renderHuman(report);
  assert.match(human, /FAIL src\/a\.ts:1 \(schema\)/);
  assert.ok(!human.includes(f.root), `absolute path leaked into the human report`);
});

// --- SPGD-1521: the structural pass — stacked comment-form `@intent` --------
//
// A run of ≥2 consecutive comment-form `@intent` lines immediately above an
// example leaves every line of the run but the LAST dead: the one-line
// lookback (SPGD-12 §2) claims only the line directly above the example.
// These findings are client-produced (unreachable.ts), appended to the
// binary's own, so exit 1 and both renderers pick them up with no second
// path. The Ruby twin's stacked arm (SPGD-900) is the reference; the pins
// below mirror its acceptance cases.

const STACKED_INTENT_A =
  '// @intent: {"entity":"Cart","action":"add","behavior":"adds an item to an empty cart","layer":"unit"}';
const STACKED_INTENT_B =
  '// @intent: {"entity":"Cart","action":"add","behavior":"increments quantity for a duplicate item","layer":"unit"}';
const STACKED_INTENT_C =
  '// @intent: {"entity":"Cart","action":"add","behavior":"clears the cart on checkout","layer":"unit"}';

test("stacked comment-form @intent lines above one test exit 1 — the UPPER line is unreachable", () => {
  const f = makeRepo({
    "stacked.test.js": [
      'import { test, describe } from "node:test";',
      "",
      STACKED_INTENT_A,
      STACKED_INTENT_B,
      'test("adds", () => {});',
    ].join("\n") + "\n",
  });
  const binary = stubBackend(
    [
      { file: "stacked.test.js", line: 3, kind: null, ok: true, errors: [] },
      { file: "stacked.test.js", line: 4, kind: null, ok: true, errors: [] },
    ],
    2,
  );
  const report = inRepo(f, ["stacked.test.js"], binary);
  assert.equal(report.exitCode, EXIT_MALFORMED);
  assert.ok(!report.ok);
  // Exactly ONE finding: the LAST line of the run is the one the lookback
  // claims, so only the upper line is dead.
  const unreachable = report.findings.filter((x) => x.kind === "unreachable");
  assert.equal(unreachable.length, 1);
  assert.equal(unreachable[0]?.file, "stacked.test.js");
  assert.equal(unreachable[0]?.line, 3);
  assert.equal(unreachable[0]?.ok, false);
  assert.equal(unreachable[0]?.aboutFile, false);
  assert.ok(unreachable[0]?.errors[0]?.includes("one-line lookback"));
  // The human report names the dead line; `--json` carries the finding shape.
  const human = renderHuman(report);
  assert.match(human, /FAIL stacked\.test\.js:3 \(unreachable\)/);
  const json = JSON.parse(renderJson(report)) as {
    ok: boolean;
    findings: { file: string; line: number; kind: string; ok: boolean; errors: string[] }[];
  };
  assert.equal(json.ok, false);
  assert.deepEqual(
    json.findings.filter((x) => x.kind === "unreachable"),
    [
      {
        file: "stacked.test.js",
        line: 3,
        kind: "unreachable",
        ok: false,
        errors: unreachable[0]!.errors,
      },
    ],
  );
});

test("an unreachable finding counts in malformed but never inflates summary.annotations", () => {
  // Same fixture as above: the binary still saw and validated TWO
  // annotations (stacking discards one at EXTRACTION, not at validation),
  // so `annotations` stays the binary's count. The client-produced finding
  // rides `malformed` — it is the exit-1 driver — without being counted a
  // second time as an annotation.
  const f = makeRepo({
    "stacked.test.js": [STACKED_INTENT_A, STACKED_INTENT_B, 'test("adds", () => {});'].join("\n") + "\n",
  });
  const binary = stubBackend(
    [
      { file: "stacked.test.js", line: 1, kind: null, ok: true, errors: [] },
      { file: "stacked.test.js", line: 2, kind: null, ok: true, errors: [] },
    ],
    2,
  );
  const report = inRepo(f, ["stacked.test.js"], binary);
  assert.equal(report.exitCode, EXIT_MALFORMED);
  assert.equal(report.summary.annotations, 2);
  assert.equal(report.summary.malformed, 1);
  const human = renderHuman(report);
  assert.match(human, /specguard lint: 2 annotations, 1 malformed/);
});

test("consecutive comment-form @intent lines with NO example directly below are not unreachable", () => {
  // The run's anchor is the example: a blank line or a plain statement after
  // the run means no lookback ever claimed (or lost) anything, so there is
  // nothing to report — the same anchoring that keeps the Ruby pass off
  // annotation corpora with no examples at all.
  const f = makeRepo({
    "before-blank.test.js": [STACKED_INTENT_A, STACKED_INTENT_B, "", "const x = 1;"].join("\n") + "\n",
    "before-const.test.js": [STACKED_INTENT_A, STACKED_INTENT_B, "const x = 1;"].join("\n") + "\n",
  });
  const binary = stubBackend(
    [
      { file: "before-blank.test.js", line: 1, kind: null, ok: true, errors: [] },
      { file: "before-blank.test.js", line: 2, kind: null, ok: true, errors: [] },
      { file: "before-const.test.js", line: 1, kind: null, ok: true, errors: [] },
      { file: "before-const.test.js", line: 2, kind: null, ok: true, errors: [] },
    ],
    4,
  );
  const report = inRepo(f, ["before-blank.test.js", "before-const.test.js"], binary);
  assert.equal(report.exitCode, EXIT_OK);
  assert.ok(report.ok);
  assert.equal(report.summary.malformed, 0);
  assert.equal(report.findings.filter((x) => x.kind === "unreachable").length, 0);
});

test("a 3-line stacked run flags the first TWO lines only — the claimed last line stays unflagged", () => {
  const f = makeRepo({
    "triple.test.js": [
      STACKED_INTENT_A,
      STACKED_INTENT_B,
      STACKED_INTENT_C,
      'test("adds", () => {});',
    ].join("\n") + "\n",
  });
  const binary = stubBackend(
    [
      { file: "triple.test.js", line: 1, kind: null, ok: true, errors: [] },
      { file: "triple.test.js", line: 2, kind: null, ok: true, errors: [] },
      { file: "triple.test.js", line: 3, kind: null, ok: true, errors: [] },
    ],
    3,
  );
  const report = inRepo(f, ["triple.test.js"], binary);
  assert.equal(report.exitCode, EXIT_MALFORMED);
  const unreachable = report.findings.filter((x) => x.kind === "unreachable");
  assert.deepEqual(
    unreachable.map((x) => x.line),
    [1, 2],
  );
});

test("the structural pass contributes nothing for a file it cannot scan (oversize), and the run stays exit 0", () => {
  // The file opens with a stacked pair the pass WOULD flag if it read the
  // text; the byte budget (the same SCAN_MAX_BYTES scanTokens applies) means
  // the pass contributes nothing instead. Exit 2 is the oversize file's own
  // arm and is not this pin's subject — with a working binary that ratifies
  // oversize files normally, nothing here may borrow exit 1.
  const f = makeRepo({});
  fs.writeFileSync(
    path.join(f.root, "big-stacked.test.js"),
    Buffer.concat([
      Buffer.from(STACKED_INTENT_A + "\n" + STACKED_INTENT_B + "\n" + 'test("adds", () => {});\n'),
      Buffer.alloc(SCAN_MAX_BYTES + 1, "x"),
    ]),
  );
  const binary = stubBackend(
    [
      { file: "big-stacked.test.js", line: 1, kind: null, ok: true, errors: [] },
      { file: "big-stacked.test.js", line: 2, kind: null, ok: true, errors: [] },
    ],
    2,
  );
  const report = inRepo(f, ["big-stacked.test.js"], binary);
  assert.equal(report.exitCode, EXIT_OK);
  assert.ok(report.ok);
  assert.equal(report.findings.filter((x) => x.kind === "unreachable").length, 0);
  assert.equal(report.summary.malformed, 0);
});

// --- SPGD-1524: the structural pass — group-line `@intent` ------------------
//
// An `@intent:` trailing on a describe/suite/context GROUP line is dead in a
// second way: the line is no example's own and it is not comment-only, so
// the one-line lookback (SPGD-12 §2) can never claim it and the test beneath
// ingests as unannotated. These findings are client-produced
// (unreachable.ts, groupLineFindingsInText), appended by the same producer
// as the stacked arm, so exit 1 and both renderers pick them up with no
// second path. The Ruby twin's group arm (SPGD-1510,
// scanner.rb group_line_findings_in_text) is the reference; the pins below
// mirror its acceptance cases, one per ticket AC.

const GROUP_INTENT =
  'describe("Cart", () => { // @intent: {"entity":"Cart","action":"add","behavior":"adds an item to an empty cart","layer":"unit"}';

test("an @intent: trailing on a describe group line exits 1 — the line is unreachable", () => {
  const f = makeRepo({
    "group.test.js": [
      'import { test, describe } from "node:test";',
      "",
      GROUP_INTENT,
      '  test("adds", () => {});',
      "});",
    ].join("\n") + "\n",
  });
  const binary = stubBackend(
    [{ file: "group.test.js", line: 3, kind: null, ok: true, errors: [] }],
    1,
  );
  const report = inRepo(f, ["group.test.js"], binary);
  assert.equal(report.exitCode, EXIT_MALFORMED);
  assert.ok(!report.ok);
  const unreachable = report.findings.filter((x) => x.kind === "unreachable");
  assert.equal(unreachable.length, 1);
  assert.equal(unreachable[0]?.file, "group.test.js");
  assert.equal(unreachable[0]?.line, 3);
  assert.equal(unreachable[0]?.ok, false);
  assert.equal(unreachable[0]?.aboutFile, false);
  assert.ok(unreachable[0]?.errors[0]?.includes("never to groups"));
  // The human report names the dead line; `--json` carries the finding shape.
  const human = renderHuman(report);
  assert.match(human, /FAIL group\.test\.js:3 \(unreachable\)/);
  const json = JSON.parse(renderJson(report)) as {
    ok: boolean;
    findings: { file: string; line: number; kind: string; ok: boolean; errors: string[] }[];
  };
  assert.equal(json.ok, false);
  assert.deepEqual(
    json.findings.filter((x) => x.kind === "unreachable"),
    [
      {
        file: "group.test.js",
        line: 3,
        kind: "unreachable",
        ok: false,
        errors: unreachable[0]!.errors,
      },
    ],
  );
});

test("an @intent: trailing on a suite/context group line is unreachable — GROUP_LINE's other keywords", () => {
  // GROUP_LINE declares THREE group keywords (describe/suite/context) and the
  // docblock names all three (`describe.only(`, `suite.skip(`,
  // `context.todo(`); this pin drives the two the other fixtures in this
  // block never touch, mirroring the Ruby twin's every-keyword pin
  // (unreachable_spec.rb, "flags the trailing form on every example-group
  // keyword"). Fixtures are regex-scanned only, never executed, so the
  // suite(/context( text needs no valid import line.
  for (const keyword of ["suite", "context"]) {
    const f = makeRepo({
      "group.test.js": [
        'import { test } from "node:test";',
        "",
        GROUP_INTENT.replace("describe(", `${keyword}(`),
        '  test("adds", () => {});',
        "});",
      ].join("\n") + "\n",
    });
    const binary = stubBackend(
      [{ file: "group.test.js", line: 3, kind: null, ok: true, errors: [] }],
      1,
    );
    const report = inRepo(f, ["group.test.js"], binary);
    const unreachable = report.findings.filter((x) => x.kind === "unreachable");
    assert.equal(unreachable.length, 1, `${keyword} produced ${unreachable.length} findings`);
    assert.equal(unreachable[0]?.file, "group.test.js");
    assert.equal(unreachable[0]?.line, 3);
    assert.equal(unreachable[0]?.ok, false);
    assert.equal(report.exitCode, EXIT_MALFORMED);
  }
});

test("a group-line finding counts in malformed but never inflates summary.annotations", () => {
  // Same fixture as the pin above: the binary saw and validated the ONE
  // annotation (the group-line payload is dead at EXTRACTION, not at
  // validation), so `annotations` stays the binary's count; the
  // client-produced finding rides `malformed` as the exit-1 driver.
  const f = makeRepo({
    "group.test.js": [GROUP_INTENT, '  test("adds", () => {});', "});"].join("\n") + "\n",
  });
  const binary = stubBackend(
    [{ file: "group.test.js", line: 1, kind: null, ok: true, errors: [] }],
    1,
  );
  const report = inRepo(f, ["group.test.js"], binary);
  assert.equal(report.exitCode, EXIT_MALFORMED);
  assert.equal(report.summary.annotations, 1);
  assert.equal(report.summary.malformed, 1);
  const human = renderHuman(report);
  assert.match(human, /specguard lint: 1 annotation, 1 malformed/);
});

test("a one-liner describe that defines its own test is EXEMPT — the annotation is claimed", () => {
  // `describe(...) { test(...); }); // @intent: {...}` IS the test's own
  // line, so the trailing annotation is claimed by the example and must
  // not be flagged — the exemption is load-bearing, not cosmetic.
  const f = makeRepo({
    "one-liner.test.js": [
      'describe("Cart", () => { test("adds", () => {}); }); // @intent: {"entity":"Cart","action":"add","behavior":"adds an item to an empty cart","layer":"unit"}',
    ].join("\n") + "\n",
  });
  const binary = stubBackend(
    [{ file: "one-liner.test.js", line: 1, kind: null, ok: true, errors: [] }],
    1,
  );
  const report = inRepo(f, ["one-liner.test.js"], binary);
  assert.equal(report.exitCode, EXIT_OK);
  assert.ok(report.ok);
  assert.equal(report.findings.filter((x) => x.kind === "unreachable").length, 0);
});

test("a bare @intent: token inside a description string is prose, NOT an annotation", () => {
  // Extraction is marker-based (SPGD-8 §7), so the token also occurs inside
  // quoted strings; INTENT_WITH_PAYLOAD requires the `{` payload opener so
  // this description cannot read as an annotation.
  const f = makeRepo({
    "prose.test.js": [
      'describe("unreachable stacked @intent: annotations", () => {',
      '  test("adds", () => {});',
      "});",
    ].join("\n") + "\n",
  });
  const binary = stubBackend([], 0);
  const report = inRepo(f, ["prose.test.js"], binary);
  assert.equal(report.exitCode, EXIT_OK);
  assert.equal(report.findings.filter((x) => x.kind === "unreachable").length, 0);
});

test("payload prose CANNOT exempt a group line — the exemption reads code before the token only", () => {
  // The payload carries a REAL example call behind a `;` opener — reading
  // the WHOLE line, `; test( again` matches EXAMPLE_ON_LINE and would
  // exempt the line; the split on the token is what keeps it flagged.
  const f = makeRepo({
    "payload.test.js": [
      'describe("Cart", () => { // @intent: {"behavior":"… when it( is given …; test( again"}',
      '  test("adds", () => {});',
      "});",
    ].join("\n") + "\n",
  });
  const binary = stubBackend(
    [{ file: "payload.test.js", line: 1, kind: null, ok: true, errors: [] }],
    1,
  );
  const report = inRepo(f, ["payload.test.js"], binary);
  assert.equal(report.exitCode, EXIT_MALFORMED);
  const unreachable = report.findings.filter((x) => x.kind === "unreachable");
  assert.equal(unreachable.length, 1);
  assert.equal(unreachable[0]?.file, "payload.test.js");
  assert.equal(unreachable[0]?.line, 1);
});

test("a file carrying both shapes returns its findings in line order", () => {
  // The stacked arm flags line 2 (the upper comment of the run above the
  // test on line 4); the group arm flags line 1. The merge sorts per file,
  // so the group finding — produced SECOND — still renders first.
  const f = makeRepo({
    "both.test.js": [
      GROUP_INTENT,
      '  // @intent: {"entity":"Cart","action":"add","behavior":"increments quantity for a duplicate item","layer":"unit"}',
      '  // @intent: {"entity":"Cart","action":"add","behavior":"clears the cart on checkout","layer":"unit"}',
      '  test("adds", () => {});',
      "});",
    ].join("\n") + "\n",
  });
  const binary = stubBackend(
    [
      { file: "both.test.js", line: 1, kind: null, ok: true, errors: [] },
      { file: "both.test.js", line: 2, kind: null, ok: true, errors: [] },
      { file: "both.test.js", line: 3, kind: null, ok: true, errors: [] },
    ],
    3,
  );
  const report = inRepo(f, ["both.test.js"], binary);
  assert.equal(report.exitCode, EXIT_MALFORMED);
  const unreachable = report.findings.filter((x) => x.kind === "unreachable");
  assert.deepEqual(
    unreachable.map((x) => x.line),
    [1, 2],
  );
  assert.match(
    unreachable[0]!.errors[0]!,
    /never to groups/,
  );
  assert.match(
    unreachable[1]!.errors[0]!,
    /one-line lookback/,
  );
});

test("annotation-free repo with NO binary still exits 0 — empty is not failure", () => {
  const f = makeRepo({ "a.test.ts": "it('x', () => {});" });
  const report = inRepo(f, [], undefined);
  assert.equal(report.exitCode, EXIT_OK);
  assert.equal(report.summary.annotations, 0);
  assert.ok(report.stderr.some((l) => l.includes("warning")));
  assert.ok(report.stderr.some((l) => l.includes("not needed") || l.includes("0 annotations") || l.includes("no annotations")));
});

test("annotations present but NO binary resolves: exit 2, not a vacuous green", () => {
  const f = makeRepo({ "a.test.ts": GOOD_ANNOTATION });
  const report = inRepo(f, [], undefined);
  assert.equal(report.exitCode, EXIT_MISUSE);
  assert.ok(!report.ok);
  assert.match(report.stderr.join("\n"), /no validator backend could be resolved/);
});

test("override present but BROKEN (missing path) with annotations: exit 2", () => {
  const f = makeRepo({ "a.test.ts": GOOD_ANNOTATION });
  const report = inRepo(f, [], "/nonexistent/validate-intent");
  assert.equal(report.exitCode, EXIT_MISUSE);
  assert.match(report.stderr.join("\n"), /does not exist/);
});

test("empty repository (nothing in scope) exits 0 with a loud warning", () => {
  const f = makeRepo({ "notes.txt": "nothing relevant" });
  const report = inRepo(f, [], undefined);
  assert.equal(report.exitCode, EXIT_OK);
  assert.equal(report.summary.files, 0);
  assert.ok(report.stderr.some((l) => l.includes("selected 0")));
});

test("unreadable named file (binary read/no-match finding) is exit 2, never exit 1", () => {
  const f = makeRepo({ "a.test.ts": GOOD_ANNOTATION });
  const binary = stubBackend(
    [{ file: "missing.test.ts", kind: "no-match", ok: false, errors: ["no file(s) match"] }],
    0,
    1,
  );
  const report = inRepo(f, ["missing.test.ts"], binary);
  assert.equal(report.exitCode, EXIT_MISUSE);
  assert.match(report.stderr.join("\n"), /could not be read: missing\.test\.ts/);
  assert.equal(report.findings[0]?.file, "missing.test.ts");
});

test("a binary exiting 3 or emitting garbage is exit 2, not a false verdict", () => {
  const f = makeRepo({ "a.test.ts": GOOD_ANNOTATION });
  const badExit = stubBackend([], 0, 3);
  assert.equal(inRepo(f, [], badExit).exitCode, EXIT_MISUSE);

  // A stub that answers the probes but writes garbage for --source.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specguard-validator-"));
  const garbage = path.join(dir, "validate-intent");
  fs.writeFileSync(
    garbage,
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
  const report = inRepo(f, [], garbage);
  assert.equal(report.exitCode, EXIT_MISUSE);
  assert.match(report.stderr.join("\n"), /did not emit a JSON document/);
});

test("a document whose annotations count disagrees with its findings is exit 2", () => {
  const f = makeRepo({ "a.test.ts": GOOD_ANNOTATION });
  const binary = stubBackend(
    [{ file: "a.test.ts", line: 1, kind: null, ok: true, errors: [] }],
    5, // declares 5, emits 1 — the truncation guard
  );
  const report = inRepo(f, [], binary);
  assert.equal(report.exitCode, EXIT_MISUSE);
  assert.match(report.stderr.join("\n"), /reported 5 annotation/);
});

test("backend passthrough: a finding's `intent` object is carried verbatim, absent reads as null", () => {
  const f = makeRepo({ "a.test.ts": GOOD_ANNOTATION + "\nit('x', () => {});" });
  const intentPayload = {
    entity: "Order",
    action: "checkout",
    behavior: "returns 402 payment required on expired card",
    layer: "request",
    extra: { nested: [1, 2, { deep: true }] },
  };
  const withIntent = stubBackend(
    [
      { file: "a.test.ts", line: 1, kind: null, ok: true, errors: [], intent: intentPayload },
      { file: "a.test.ts", line: 5, kind: null, ok: true, errors: [] },
      { file: "a.test.ts", line: 9, kind: null, ok: true, errors: [], intent: "not-an-object" },
    ],
    3,
  );
  const report = inRepo(f, [], withIntent);
  assert.equal(report.exitCode, EXIT_OK);
  assert.deepEqual(report.findings[0]!.intent, intentPayload);
  assert.equal(report.findings[1]!.intent, null); // absent (v0.1.3 shape)
  assert.equal(report.findings[2]!.intent, null); // non-object reads as null, never a refusal
});

test("GUARD: a FAILING finding with a non-string kind is exit 2 — tolerance is for the passing shape ONLY", () => {
  // The binary emits `kind: null` on PASSING findings; a FAILING finding
  // still owes its kind name. A stub that fails a site while omitting the
  // kind is a contract violation: exit 2, never a verdict (malformed, exit
  // 1) borrowed under a kind nobody can render.
  const f = makeRepo({ "a.test.ts": BAD_ANNOTATION + "\nit('x', () => {});" });
  const binary = stubBackend(
    [{ file: "a.test.ts", line: 1, kind: null, ok: false, errors: ["entity: is missing"] }],
    1,
    1,
  );
  const report = inRepo(f, [], binary);
  assert.equal(report.exitCode, EXIT_MISUSE);
  assert.match(report.stderr.join("\n"), /emitted a finding on a\.test\.ts with no `kind`/);
});

test("GUARD: a FAILING finding with an UNKNOWN string kind is exit 2, exactly as Ruby's failing_result raises", () => {
  // The binary documents its failure vocabulary (schema/extraction/parse/
  // read/no-match). A kind outside it is the port growing words this client
  // has not been taught — refusing keeps the divergence visible.
  const f = makeRepo({ "a.test.ts": BAD_ANNOTATION + "\nit('x', () => {});" });
  const binary = stubBackend(
    [{ file: "a.test.ts", line: 1, kind: "banana", ok: false, errors: ["entity: is missing"] }],
    1,
    1,
  );
  const report = inRepo(f, [], binary);
  assert.equal(report.exitCode, EXIT_MISUSE);
  assert.match(report.stderr.join("\n"), /emitted the unknown kind "banana" on a\.test\.ts/);
});

test("GUARD: a passing finding with a JUNK (non-string, non-null) kind is still exit 2", () => {
  // Tolerance on the passing shape covers null/absent and (forward-compat) a
  // string — not a number. Anything else is no shape the binary emits.
  const f = makeRepo({ "a.test.ts": GOOD_ANNOTATION + "\nit('x', () => {});" });
  const binary = stubBackend(
    [{ file: "a.test.ts", line: 1, kind: 42, ok: true, errors: [] }],
    1,
  );
  const report = inRepo(f, [], binary);
  assert.equal(report.exitCode, EXIT_MISUSE);
  assert.match(report.stderr.join("\n"), /emitted a finding on a\.test\.ts with no `kind`/);
});

test("the real binary's kind:null passing shape exits 0 — the shape the old guard refused", () => {
  // The pinned regression: before the kind:null fix this exact stub (the
  // real binary's documented passing shape) was an exit-2 refusal, making
  // exit 0 unreachable with a real binary on any valid annotation.
  const f = makeRepo({
    "a.test.ts": GOOD_ANNOTATION + "\nit('x', () => {});",
    "b.test.ts": GOOD_ANNOTATION + "\nit('y', () => {});",
  });
  const binary = stubBackend(
    [
      { file: "a.test.ts", line: 1, kind: null, ok: true, errors: [] },
      { file: "b.test.ts", line: 1, kind: null, ok: true, errors: [] },
    ],
    2,
  );
  const report = inRepo(f, [], binary);
  assert.equal(report.exitCode, EXIT_OK);
  assert.ok(report.ok);
  assert.equal(report.summary.annotations, 2);
  assert.equal(report.summary.malformed, 0);
  assert.ok(report.findings.every((x) => x.ok && x.kind === null));
});

// --- SPGD-926: an unscannable file must not authorize the no-binary degrade ---
//
// `scanTokens` swallows unreadable and over-budget files into `tokens: 0`,
// which the no-binary degrade used to read as "nothing to check". Both arms
// below pin the repaired contract: exit 2, `ok: false`, ONE error line naming
// the file — and, per cli.ts's rule (exit 2 with no findings), NO stdout
// document at all: a run that could not look must not dress that as structure.

/** Captures everything the CLI writes to one stream (it only ever .write()s). */
function capture(): { lines: string[]; stream: NodeJS.WriteStream } {
  const lines: string[] = [];
  const stream = {
    write: (chunk: string | Uint8Array): boolean => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    },
  };
  return { lines, stream: stream as unknown as NodeJS.WriteStream };
}

/**
 * Runs the CLI entry point itself (not lint()) inside the fixture, with the
 * validator override scrubbed from the real environment so the no-binary arm
 * is what resolves — the CLI reads process.env, so the scrub is the only way
 * to make that deterministic. Pass `bin` (a stubBackend path) to run against
 * a working backend instead: the variable is SET rather than scrubbed.
 */
function runCliInRepo(
  fixture: Fixture,
  argv: string[],
  dir: string = fixture.root,
  bin?: string,
): { exit: number; stdout: string; stderr: string } {
  const out = capture();
  const err = capture();
  const previousCwd = process.cwd();
  const previousOverride = process.env[VALIDATE_INTENT_ENV_VAR];
  if (bin === undefined) delete process.env[VALIDATE_INTENT_ENV_VAR];
  else process.env[VALIDATE_INTENT_ENV_VAR] = bin;
  process.chdir(dir);
  try {
    const exit = runCli(argv, out.stream, err.stream);
    return { exit, stdout: out.lines.join(""), stderr: err.lines.join("") };
  } finally {
    process.chdir(previousCwd);
    if (previousOverride === undefined) delete process.env[VALIDATE_INTENT_ENV_VAR];
    else process.env[VALIDATE_INTENT_ENV_VAR] = previousOverride;
  }
}

test(
  "UNREADABLE annotated file, NO binary: exit 2 — 'could not look' is not 'nothing to check'",
  {
    skip:
      process.getuid?.() === 0
        ? "root bypasses file permissions — the chmod 000 fixture would be readable and this arm would pass vacuously"
        : false,
  },
  () => {
    const f = makeRepo({
      "guarded.ts": GOOD_ANNOTATION, // carries a token, but chmod 000 makes it unscannable
      "plain.ts": "const one = 1;\n",
    });
    fs.chmodSync(path.join(f.root, "guarded.ts"), 0o000);
    const report = inRepo(f, [], undefined);
    assert.equal(report.exitCode, EXIT_MISUSE);
    assert.ok(!report.ok);
    const errorLines = report.stderr.filter((l) => l.startsWith("specguard lint: error:"));
    assert.equal(errorLines.length, 1);
    assert.match(errorLines[0]!, /guarded\.ts/);
    // No synthesized findings — the client never manufactures what only the
    // binary could report; the names live on stderr, which is what makes
    // cli.ts's rule suppress the stdout document for this run.
    assert.equal(report.findings.length, 0);
    const cli = runCliInRepo(f, ["lint", "--json"]);
    assert.equal(cli.exit, 2);
    assert.equal(cli.stdout, ""); // not `ok: true`, not an empty document — nothing
    assert.match(cli.stderr, /specguard lint: error: .*guarded\.ts/);
  },
);

test("OVERSIZED (> SCAN_MAX_BYTES) annotated file, NO binary: exit 2 — the unconditional arm", () => {
  // The oversized swallow needs no privileges to arm, so this arm runs
  // everywhere (root included): one file over the byte budget, opening with
  // a valid annotation, and no binary to hand the failure to.
  const f = makeRepo({});
  fs.writeFileSync(
    path.join(f.root, "big.ts"),
    Buffer.concat([Buffer.from(GOOD_ANNOTATION + "\n"), Buffer.alloc(SCAN_MAX_BYTES + 1, "x")]),
  );
  const report = inRepo(f, [], undefined);
  assert.equal(report.exitCode, EXIT_MISUSE);
  assert.ok(!report.ok);
  const errorLines = report.stderr.filter((l) => l.startsWith("specguard lint: error:"));
  assert.equal(errorLines.length, 1);
  assert.match(errorLines[0]!, /big\.ts/);
  assert.equal(report.findings.length, 0);
  const cli = runCliInRepo(f, ["lint", "--json"]);
  assert.equal(cli.exit, 2);
  assert.equal(cli.stdout, ""); // cli.ts's rule: exit 2 + no findings ⇒ no document
  assert.match(cli.stderr, /specguard lint: error: .*big\.ts/);
});

// --- SPGD-1546: the unscannableClause register at the misuse arm -------------
//
// The two SPGD-926 pins above assert name-presence only (`/guarded\.ts/`,
// `/specguard lint: error: .*guarded\.ts/`), which is exactly the looseness
// SPGD-1533 removed from every other walk surface: four independent
// mutations each leave the whole suite green — (a) restoring the absolute
// register via `path.resolve(process.cwd(), s.file)`, (b) building the name
// list from `selection.files` instead of `unscannable` (scannable files
// named as unscannable), (c) swapping the helper's `join(", ")`, and (d)
// dropping the helper's `N file(s)` count clause, which NO existing pin
// holds (the suite's only `/1 file\(s\)/` assertions ride annotate's
// post-backend hand-rolled clause). These pins hold the register the way
// the binary-side read register is held above (full-literal deepEqual) and
// the way SPGD-1537 pinned the annotate consumer: the whole stderr stream,
// byte-for-byte, at both the lint() and the CLI boundary.

test(
  "SPGD-1546: the misuse register is byte-pinned — root-relative names of ONLY the unscannable files, comma-joined, with the count clause (one unreadable + one oversize beside a scannable file, NO binary)",
  {
    skip:
      process.getuid?.() === 0
        ? "root bypasses file permissions — the chmod 000 fixture would be readable and this arm would pass vacuously"
        : false,
  },
  () => {
    // Both unscannable CAUSES in one run (unreadable + oversize), plus one
    // perfectly scannable file the register must never name: a name list
    // drawn from `selection.files` (mutation b) would name plain.ts; an
    // absolute register (a), a swapped join (c) or a dropped count clause
    // (d) each fail the byte-pin on their own axis.
    const f = makeRepo({
      "b_guarded.ts": GOOD_ANNOTATION, // carries a token, but chmod 000 makes it unscannable
      "plain.ts": "const one = 1;\n", // scannable — must never be named
    });
    fs.writeFileSync(
      path.join(f.root, "a_big.ts"),
      Buffer.concat([Buffer.from(GOOD_ANNOTATION + "\n"), Buffer.alloc(SCAN_MAX_BYTES + 1, "x")]),
    );
    fs.chmodSync(path.join(f.root, "b_guarded.ts"), 0o000);
    const report = inRepo(f, [], undefined);
    assert.equal(report.exitCode, EXIT_MISUSE);
    assert.ok(!report.ok);
    assert.equal(report.backend, null);
    assert.equal(report.findings.length, 0);
    // Walk order is sorted, so the oversize file is named first; both
    // causes count into the one clause; the clause rides backendNote and
    // stderr composed from the same call.
    const clause = `2 file(s) could not be scanned (unreadable or larger than ${SCAN_MAX_BYTES} bytes): a_big.ts, b_guarded.ts`;
    assert.equal(report.backendNote, clause);
    assert.deepEqual(report.summary, { files: 3, annotations: 0, malformed: 0, unreadable: 2 });
    // The whole stream, byte-pinned: exactly the one error line — no stray
    // note or provenance line rides a walk-mode misuse run.
    assert.deepEqual(report.stderr, [`specguard lint: error: ${clause}`]);
    // The register survives to the process surface byte-for-byte, beside
    // the no-findings document suppression.
    const cli = runCliInRepo(f, ["lint", "--json"]);
    assert.equal(cli.exit, EXIT_MISUSE);
    assert.equal(cli.stdout, ""); // cli.ts's rule: exit 2 + no findings ⇒ no document
    assert.deepEqual(cli.stderr.trimEnd().split("\n"), [`specguard lint: error: ${clause}`]);
  },
);

test("SPGD-1546: the misuse register holds the SINGULAR count clause — '1 file(s)' naming only the oversize file beside a scannable one (runs everywhere, no privileges)", () => {
  // The suite's first pin of the singular rendering on the SHARED helper:
  // the existing `/1 file\(s\)/` assertions (annotate.test.ts) ride that
  // consumer's post-backend hand-rolled clause, so before this pin the
  // helper's count clause was held by nothing for the 1-file case. The
  // scannable sibling also holds the only-the-unscannable shape without
  // privileges (mutation b) for hosts where the chmod pin skips.
  const f = makeRepo({ "plain.ts": "const one = 1;\n" });
  fs.writeFileSync(
    path.join(f.root, "big.ts"),
    Buffer.concat([Buffer.from(GOOD_ANNOTATION + "\n"), Buffer.alloc(SCAN_MAX_BYTES + 1, "x")]),
  );
  const report = inRepo(f, [], undefined);
  assert.equal(report.exitCode, EXIT_MISUSE);
  const clause = `1 file(s) could not be scanned (unreadable or larger than ${SCAN_MAX_BYTES} bytes): big.ts`;
  assert.equal(report.backendNote, clause);
  assert.deepEqual(report.summary, { files: 2, annotations: 0, malformed: 0, unreadable: 1 });
  assert.deepEqual(report.stderr, [`specguard lint: error: ${clause}`]);
});

// --- SPGD-1124: the CLI boundary of the exit contract -----------------------
//
// lint() deliberately re-throws anything that is not a typed verdict; before
// this slice the re-throw escaped run() to Node's uncaught-exception default
// — exit 1, which the contract defines as "malformed annotations". A crashed
// run must never wear that verdict: the boundary catch in run() lands it on
// exit 2 with one stderr line and no document.

test(
  "an internal throw escaping lint() lands on the CLI boundary: exit 2, an internal-error line on stderr, NO document — never Node's default exit 1",
  () => {
    // No mock framework: the stub replaces process.cwd, whose call sits
    // inside lint()'s selection try (the selectFiles argument list), so the
    // plain Error takes exactly the re-throw path the SPGD-1121 crash took.
    const out = capture();
    const err = capture();
    const originalCwd = process.cwd.bind(process);
    process.cwd = () => {
      throw new Error("synthetic boundary escape: cwd exploded");
    };
    try {
      const exit = runCli(["lint"], out.stream, err.stream);
      assert.equal(exit, EXIT_MISUSE);
      assert.equal(out.lines.join(""), ""); // a crashed run emits no document
      assert.match(
        err.lines.join(""),
        /^specguard lint: internal error: synthetic boundary escape: cwd exploded\n$/,
      );
    } finally {
      process.cwd = originalCwd;
    }
  },
);

// --- SPGD-1001: `--changed` — the git-diff selection mode -------------------
//
// The Ruby client's settled decisions, ported and pinned: the diff base is
// the merge base with the default branch (never a bare working-tree-vs-index
// `git diff --name-only`, whose emptiness in a clean CI checkout is SPGD-76's
// silent exit-green-having-checked-nothing); deleted paths are dropped;
// the selection is cwd-scoped like the walk; an empty selection is loud and
// names the filter that emptied it; `--changed` + named files is misuse; a
// thin base (HEAD fallback) is disclosed, never silent.

/** Real git in a fixture — the feature under test IS the git integration. */
function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function initRepo(files: Record<string, string>, branch = "main"): Fixture {
  const f = makeRepo(files);
  git(f.root, "init", "-b", branch);
  git(f.root, "config", "user.email", "specguard-test@example.com");
  git(f.root, "config", "user.name", "specguard-test");
  return f;
}

function commitAll(fixture: Fixture, message: string): void {
  git(fixture.root, "add", "-A");
  git(fixture.root, "commit", "--allow-empty", "-m", message);
}

test("changed mode selects exactly the committed change against the merge base", () => {
  // Clean tree after commit — the CI state SPGD-76 measured bare
  // `git diff --name-only` failing in.
  const f = initRepo({
    "src/a.ts": GOOD_ANNOTATION,
    "src/keep.ts": GOOD_ANNOTATION + "\n",
  });
  commitAll(f, "base");
  git(f.root, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(f.root, "src/a.ts"), GOOD_ANNOTATION + "\n// touched\n");
  fs.writeFileSync(path.join(f.root, "src/new.ts"), GOOD_ANNOTATION);
  commitAll(f, "feature change");

  const selection = selectFiles([], f.root, { changed: true });
  assert.equal(selection.mode, "changed");
  assert.deepEqual(selection.files, ["src/a.ts", "src/new.ts"]);
  assert.ok(!selection.files.includes("src/keep.ts"));
  assert.equal(selection.base, git(f.root, "merge-base", "HEAD", "main").trim());
  // A feature branch's merge base is not HEAD: no apology needed.
  assert.equal(selection.note, null);
  assert.deepEqual(
    selection.stats,
    { changed: 2, matches: 2, outsideRoot: 0, unreadable: 0, untracked: 0 },
  );
});

test("changed mode with a malformed annotation: exit 1 naming file and line; the untouched file is not checked", () => {
  const f = initRepo({ "src/a.ts": GOOD_ANNOTATION, "src/keep.ts": BAD_ANNOTATION });
  commitAll(f, "base");
  git(f.root, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(f.root, "src/a.ts"), BAD_ANNOTATION);
  commitAll(f, "break a.ts only");

  const binary = stubBackend(
    [{ file: "src/a.ts", line: 1, kind: "schema", ok: false, errors: ["entity: is missing"] }],
    1,
    1,
  );
  const report = inRepo(f, [], binary, { changed: true });
  assert.equal(report.exitCode, EXIT_MALFORMED);
  assert.equal(report.summary.files, 1); // keep.ts changed nothing and is not in scope
  assert.equal(report.findings[0]?.file, "src/a.ts");
  assert.equal(report.findings[0]?.line, 1);
  assert.ok(report.findings.every((f) => f.file !== "src/keep.ts"));
});

test("a deleted annotated file in the diff is dropped, never selected or counted", () => {
  const f = initRepo({ "src/a.ts": GOOD_ANNOTATION, "src/gone.ts": GOOD_ANNOTATION });
  commitAll(f, "base");
  git(f.root, "checkout", "-b", "feature");
  fs.rmSync(path.join(f.root, "src/gone.ts"));
  fs.writeFileSync(path.join(f.root, "src/a.ts"), GOOD_ANNOTATION + "\n// touched\n");
  commitAll(f, "delete gone.ts, touch a.ts");

  const selection = selectFiles([], f.root, { changed: true });
  // `--diff-filter=d` dropped the deletion at the git layer: not a selected
  // file, not a match, not an unreadable count — it never arrived.
  assert.deepEqual(selection.files, ["src/a.ts"]);
  assert.deepEqual(
    selection.stats,
    { changed: 1, matches: 1, outsideRoot: 0, unreadable: 0, untracked: 0 },
  );
});

test("changed mode is cwd-scoped: running under a subdirectory selects only its files", () => {
  const f = initRepo({ "packages/app/src/a.ts": GOOD_ANNOTATION, "other/b.ts": GOOD_ANNOTATION });
  commitAll(f, "base");
  git(f.root, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(f.root, "packages/app/src/a.ts"), GOOD_ANNOTATION + "\n// touched\n");
  fs.writeFileSync(path.join(f.root, "other/b.ts"), GOOD_ANNOTATION + "\n// touched\n");
  commitAll(f, "touch both");

  // Git names paths from the repo root; the selection must not silently
  // widen to repo scope while the walk stays cwd-scoped.
  const selection = selectFiles([], path.join(f.root, "packages/app"), { changed: true });
  assert.deepEqual(selection.files, ["src/a.ts"]);
  assert.deepEqual(
    selection.stats,
    { changed: 2, matches: 2, outsideRoot: 1, unreadable: 0, untracked: 0 },
  );
});

test("--changed=<base> overrides the derived merge base", () => {
  const f = initRepo({ "src/a.ts": GOOD_ANNOTATION, "src/b.ts": GOOD_ANNOTATION });
  commitAll(f, "base");
  git(f.root, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(f.root, "src/b.ts"), GOOD_ANNOTATION + "\n// one\n");
  commitAll(f, "first change");
  const afterFirst = git(f.root, "rev-parse", "HEAD").trim();
  fs.writeFileSync(path.join(f.root, "src/a.ts"), GOOD_ANNOTATION + "\n// two\n");
  commitAll(f, "second change");

  const derived = selectFiles([], f.root, { changed: true });
  assert.deepEqual(derived.files, ["src/a.ts", "src/b.ts"]); // both feature commits

  const sinceFirst = selectFiles([], f.root, { changed: true, base: afterFirst });
  assert.deepEqual(sinceFirst.files, ["src/a.ts"]); // only the second commit
  assert.equal(sinceFirst.base, afterFirst);
});

test("no default-branch ref: the base falls back to HEAD and the degrade is disclosed, never silent", () => {
  // Branch named neither main nor master, no origin/*: no DEFAULT_BRANCH_REFS
  // entry resolves, so the only base left is HEAD — uncommitted work only.
  const f = initRepo({ "src/a.ts": GOOD_ANNOTATION }, "feature");
  commitAll(f, "base");
  fs.writeFileSync(path.join(f.root, "src/a.ts"), GOOD_ANNOTATION + "\n// uncommitted\n");

  const selection = selectFiles([], f.root, { changed: true });
  assert.equal(selection.mode, "changed");
  assert.deepEqual(selection.files, ["src/a.ts"]);
  assert.equal(selection.base, git(f.root, "rev-parse", "HEAD").trim());
  assert.match(selection.note ?? "", /fell back to HEAD/);
  assert.match(selection.note ?? "", /uncommitted changes/);

  // The disclosure rides stderr on the real run, not just the selection object.
  const binary = stubBackend([{ file: "src/a.ts", line: 1, kind: null, ok: true, errors: [] }], 1);
  const report = inRepo(f, [], binary, { changed: true });
  assert.equal(report.exitCode, EXIT_OK);
  assert.ok(report.stderr.some((l) => l.includes("fell back to HEAD")));
});

test("outside a git repository: --changed is exit 2 with the reason and no stdout document", () => {
  const f = makeRepo({ "a.ts": GOOD_ANNOTATION }); // no git init
  const cli = runCliInRepo(f, ["lint", "--changed"]);
  assert.equal(cli.exit, EXIT_MISUSE);
  assert.equal(cli.stdout, "");
  assert.match(cli.stderr, /specguard lint: error: --changed requires a git repository/);
});

test("a git repository with no default ref and no HEAD commit: exit 2 naming the unresolvable base", () => {
  const f = makeRepo({ "a.ts": GOOD_ANNOTATION });
  git(f.root, "init", "-b", "feature"); // no commits, no main/master, no origin/*
  const cli = runCliInRepo(f, ["lint", "--changed"]);
  assert.equal(cli.exit, EXIT_MISUSE);
  assert.equal(cli.stdout, "");
  assert.match(cli.stderr, /could not determine a diff base/);
  assert.match(cli.stderr, /pass --changed=<base> explicitly/);
});

test("loud empty, case 1: nothing changed against the base — exit 0, reason and HEAD-base note on stderr", () => {
  // A default-branch build after a merge: HEAD == main == merge base, the
  // diff is legitimately empty. Exit stays 0; stderr says why, and the note
  // distinguishes this normal case from a degraded fallback.
  const f = initRepo({ "src/a.ts": GOOD_ANNOTATION });
  commitAll(f, "base"); // clean tree

  const cli = runCliInRepo(f, ["lint", "--changed"]);
  assert.equal(cli.exit, EXIT_OK);
  assert.match(cli.stderr, /selected 0 annotated source files — nothing changed against /);
  assert.match(cli.stderr, /the diff base is HEAD itself/);
});

test("loud empty, case 2: changes exist but none match the annotated extensions — exit 0, the filter named", () => {
  const f = initRepo({ "src/a.ts": GOOD_ANNOTATION });
  commitAll(f, "base");
  git(f.root, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(f.root, "README.md"), "# docs only\n");
  fs.writeFileSync(path.join(f.root, "notes.txt"), "prose\n");
  commitAll(f, "docs change");

  const cli = runCliInRepo(f, ["lint", "--changed"]);
  assert.equal(cli.exit, EXIT_OK);
  assert.match(cli.stderr, /2 files changed against /);
  assert.match(cli.stderr, /none matching the annotated extensions/);
});

test("loud empty, case 3: the only changed annotated file is outside the current directory", () => {
  const f = initRepo({ "packages/app/src/a.ts": GOOD_ANNOTATION, "other/b.ts": GOOD_ANNOTATION });
  commitAll(f, "base");
  git(f.root, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(f.root, "other/b.ts"), GOOD_ANNOTATION + "\n// touched\n");
  commitAll(f, "touch only other/");

  const cli = runCliInRepo(f, ["lint", "--changed"], path.join(f.root, "packages/app"));
  assert.equal(cli.exit, EXIT_OK);
  assert.match(cli.stderr, /1 changed annotated-source file against /);
  assert.match(cli.stderr, /1 is outside /);
  assert.match(cli.stderr, /\(--changed selects only files under the current directory\)/);
});

test("--changed combined with explicit files is exit 2 with the drop-one remediation", () => {
  // No git fixture needed: the contradiction is misuse before git is asked.
  const f = makeRepo({ "src/a.ts": GOOD_ANNOTATION });
  const cli = runCliInRepo(f, ["lint", "--changed", "src/a.ts"]);
  assert.equal(cli.exit, EXIT_MISUSE);
  assert.equal(cli.stdout, "");
  assert.match(
    cli.stderr,
    /--changed cannot be combined with explicit files; drop one \(named files are checked as given, --changed derives them from the diff\)/,
  );
});

test("a --changed run discloses its provenance: mode in --json, 'changed since' in the human report", () => {
  const f = initRepo({ "src/a.ts": GOOD_ANNOTATION });
  commitAll(f, "base");
  git(f.root, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(f.root, "src/a.ts"), GOOD_ANNOTATION + "\n// touched\n");
  commitAll(f, "touch");

  const binary = stubBackend([{ file: "src/a.ts", line: 1, kind: null, ok: true, errors: [] }], 1);
  const report = inRepo(f, [], binary, { changed: true });
  assert.equal(report.exitCode, EXIT_OK);

  const json = JSON.parse(renderJson(report)) as {
    mode: string;
    selection?: { mode: string; base: string; note: string | null };
  };
  assert.equal(json.mode, "source"); // the document mode is untouched
  assert.equal(json.selection?.mode, "changed");
  assert.equal(json.selection?.base, git(f.root, "merge-base", "HEAD", "main").trim());
  assert.equal(json.selection?.note, null);

  const human = renderHuman(report);
  assert.match(human, /checked 1 source file changed since /);

  // Walk mode stays silent about selection — the document is byte-identical
  // in shape to its previous self.
  const walked = inRepo(f, [], binary);
  assert.equal((JSON.parse(renderJson(walked)) as { selection?: unknown }).selection, undefined);
  assert.doesNotMatch(renderHuman(walked), /changed since/);
});

// ---------------------------------------------------------------------------
// SPGD-1121: untracked files. `git diff` cannot see a file that has never
// been `git add`ed, but "what changed against <base>, whether or not the
// change is committed yet" covers it — a diff-only name set rode the branch's
// newest spec past the gate behind a non-empty checked-count in the mixed
// shape every real working tree has, and fired a false "nothing changed" in
// the untracked-only shape. The name set is the union of the diff leg and
// one `git ls-files --others --exclude-standard -z` call per selection (the
// specguard-ts mirror of the Ruby client's landed SPGD-1119).
// ---------------------------------------------------------------------------

test("changed mode selects an untracked new spec alongside a tracked change (the mixed shape)", () => {
  const f = initRepo({ "src/a.ts": GOOD_ANNOTATION });
  commitAll(f, "base");
  git(f.root, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(f.root, "src/a.ts"), GOOD_ANNOTATION + "\n// touched\n");
  // NEVER added: invisible to `git diff`, visible to `git status` as `??`.
  fs.writeFileSync(path.join(f.root, "src/new_untracked.ts"), BAD_ANNOTATION);

  const selection = selectFiles([], f.root, { changed: true });
  assert.deepEqual(selection.files, ["src/a.ts", "src/new_untracked.ts"]);
  assert.deepEqual(
    selection.stats,
    { changed: 2, matches: 2, outsideRoot: 0, unreadable: 0, untracked: 1 },
  );
});

test("changed mode with a malformed untracked annotation: exit 1, not exit 0 behind a checked-count of 1", () => {
  const f = initRepo({ "src/a.ts": GOOD_ANNOTATION });
  commitAll(f, "base");
  git(f.root, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(f.root, "src/a.ts"), GOOD_ANNOTATION + "\n// touched\n");
  fs.writeFileSync(path.join(f.root, "src/new_untracked.ts"), BAD_ANNOTATION);

  const binary = stubBackend(
    [
      { file: "src/a.ts", line: 1, kind: null, ok: true, errors: [] },
      { file: "src/new_untracked.ts", line: 1, kind: "schema", ok: false, errors: ["entity: is missing"] },
    ],
    2,
    1,
  );
  const report = inRepo(f, [], binary, { changed: true });
  assert.equal(report.exitCode, EXIT_MALFORMED);
  assert.equal(report.summary.files, 2);
  assert.ok(report.findings.some((f) => f.file === "src/new_untracked.ts"));
});

test("an untracked-only working tree selects the new spec instead of reporting nothing changed", () => {
  // The branch's only spec change is a file git has never been told about.
  // Before the untracked leg this was the loud-empty machinery firing a FALSE
  // "nothing changed against <base>".
  const f = initRepo({ "src/a.ts": GOOD_ANNOTATION });
  commitAll(f, "base");
  git(f.root, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(f.root, "src/brand_new.ts"), GOOD_ANNOTATION);

  const selection = selectFiles([], f.root, { changed: true });
  assert.deepEqual(selection.files, ["src/brand_new.ts"]);
  assert.deepEqual(
    selection.stats,
    { changed: 1, matches: 1, outsideRoot: 0, unreadable: 0, untracked: 1 },
  );

  const binary = stubBackend(
    [{ file: "src/brand_new.ts", line: 1, kind: null, ok: true, errors: [] }],
    1,
  );
  const report = inRepo(f, [], binary, { changed: true });
  assert.equal(report.exitCode, EXIT_OK);
  assert.ok(
    !report.stderr.join("\n").includes("nothing changed against"),
    `the false empty reason fired despite an untracked spec:\n${report.stderr.join("\n")}`,
  );
});

test("a gitignored untracked spec is never selected — `--exclude-standard` is the boundary", () => {
  const f = initRepo({ "src/a.ts": GOOD_ANNOTATION, ".gitignore": "scratch/\n" });
  commitAll(f, "base");
  git(f.root, "checkout", "-b", "feature");
  fs.mkdirSync(path.join(f.root, "scratch"));
  fs.writeFileSync(path.join(f.root, "scratch/ignored.ts"), BAD_ANNOTATION);

  const selection = selectFiles([], f.root, { changed: true });
  assert.deepEqual(selection.files, []);
  // The gitignored file is not a changed-annotated count anywhere: git never
  // offered it, so the union is empty and the loud-empty truth is exact.
  assert.deepEqual(
    selection.stats,
    { changed: 0, matches: 0, outsideRoot: 0, unreadable: 0, untracked: 0 },
  );
});

test("an untracked spec outside the current directory is counted outside, not checked", () => {
  const f = initRepo({ "packages/app/src/a.ts": GOOD_ANNOTATION });
  commitAll(f, "base");
  git(f.root, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(f.root, "packages/app/src/a.ts"), GOOD_ANNOTATION + "\n// touched\n");
  fs.mkdirSync(path.join(f.root, "other"));
  fs.writeFileSync(path.join(f.root, "other/untracked.ts"), GOOD_ANNOTATION);

  // Running under packages/app: the untracked leg still lists repo-root
  // paths (it runs at the toplevel), and the scoping rules apply uniformly.
  const selection = selectFiles([], path.join(f.root, "packages/app"), { changed: true });
  assert.deepEqual(selection.files, ["src/a.ts"]);
  assert.deepEqual(
    selection.stats,
    { changed: 2, matches: 2, outsideRoot: 1, unreadable: 0, untracked: 0 },
  );
});

test("an untracked spec is selected in a shallow clone too — the untracked leg needs no history", () => {
  const f = initShallowClone({ "src/a.ts": GOOD_ANNOTATION });
  fs.writeFileSync(path.join(f.root, "src/new_untracked.ts"), GOOD_ANNOTATION);

  const selection = selectFiles([], f.root, { changed: true });
  assert.deepEqual(selection.files, ["src/new_untracked.ts"]);
  assert.deepEqual(
    selection.stats,
    { changed: 1, matches: 1, outsideRoot: 0, unreadable: 0, untracked: 1 },
  );
});

test("stats.untracked pins both legs: zero for a tracked-only tree, exact for the untracked leg", () => {
  // Tracked-only: the untracked leg contributed nothing and says so.
  const tracked = initRepo({ "src/a.ts": GOOD_ANNOTATION });
  commitAll(tracked, "base");
  git(tracked.root, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(tracked.root, "src/a.ts"), GOOD_ANNOTATION + "\n// touched\n");
  const trackedSelection = selectFiles([], tracked.root, { changed: true });
  assert.equal(trackedSelection.stats?.untracked, 0);

  // Mixed: the untracked count names ONLY the files that arrived via the
  // untracked leg, never the diff's.
  const mixed = initRepo({ "src/a.ts": GOOD_ANNOTATION });
  commitAll(mixed, "base");
  git(mixed.root, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(mixed.root, "src/a.ts"), GOOD_ANNOTATION + "\n// touched\n");
  fs.writeFileSync(path.join(mixed.root, "src/new.ts"), GOOD_ANNOTATION);
  fs.writeFileSync(path.join(mixed.root, "src/newer.ts"), GOOD_ANNOTATION);
  const mixedSelection = selectFiles([], mixed.root, { changed: true });
  assert.equal(mixedSelection.stats?.untracked, 2);
  assert.equal(mixedSelection.stats?.changed, 3);
});

test("the checked-count clause says 'including N untracked' when the leg contributed, and never otherwise", () => {
  // Mixed shape: the human line names the untracked provenance.
  const mixed = initRepo({ "src/a.ts": GOOD_ANNOTATION });
  commitAll(mixed, "base");
  git(mixed.root, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(mixed.root, "src/a.ts"), GOOD_ANNOTATION + "\n// touched\n");
  fs.writeFileSync(path.join(mixed.root, "src/new_untracked.ts"), BAD_ANNOTATION);
  const binary = stubBackend(
    [{ file: "src/new_untracked.ts", line: 1, kind: "schema", ok: false, errors: ["entity: is missing"] }],
    2,
    1,
  );
  const mixedReport = inRepo(mixed, [], binary, { changed: true });
  const human = renderHuman(mixedReport);
  assert.match(human, /checked 2 source files changed since \S+ including 1 untracked/);

  // `--json`'s selection block keeps its exact shape (mode, base, note) —
  // the disclosure rides the human line, not a new document key.
  const json = JSON.parse(renderJson(mixedReport)) as {
    selection?: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(json.selection ?? {}), ["mode", "base", "note"]);

  // Tracked-only tree: no clause at all — the line cannot over-claim.
  const tracked = initRepo({ "src/a.ts": GOOD_ANNOTATION });
  commitAll(tracked, "base");
  git(tracked.root, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(tracked.root, "src/a.ts"), GOOD_ANNOTATION + "\n// touched\n");
  const trackedBinary = stubBackend(
    [{ file: "src/a.ts", line: 1, kind: null, ok: true, errors: [] }],
    1,
  );
  const trackedReport = inRepo(tracked, [], trackedBinary, { changed: true });
  const trackedHuman = renderHuman(trackedReport);
  assert.match(trackedHuman, /checked 1 source file changed since /);
  assert.ok(!trackedHuman.includes("untracked"), `clause leaked on a tracked-only tree:\n${trackedHuman}`);

  // Walk mode stays clause-free: the disclosure is `changed`-mode's own.
  const walked = inRepo(tracked, [], trackedBinary);
  assert.doesNotMatch(renderHuman(walked), /untracked/);
});

test("the changed-mode name union is built size-safely — it must hold where spread would crash", () => {
  // `push(...leg)` is call-stack-bound: once a leg outgrows Node's
  // spread-argument budget it throws `RangeError: Maximum call stack size
  // exceeded`, and a large untracked leg is a real shape (a repository whose
  // `.gitignore` does not yet cover `node_modules`). A crash there dies in
  // selection, before the validator runs, and exits non-zero on empty output
  // — which the exit contract reads as malformed annotations. This pin feeds
  // the union a leg no spread call could survive, so the property is
  // enforced rather than remembered.
  const untrackedLeg = Array.from(
    { length: 500_000 },
    (_, i) => `node_modules/pkg_${i}/lib/f.js`,
  );
  const union = changedNameUnion(["src/a.ts"], untrackedLeg);
  assert.equal(union.length, untrackedLeg.length + 1);
  // Order is part of the shape: the diff leg first, then the untracked leg.
  assert.deepEqual(union[0], { name: "src/a.ts", untracked: false });
  assert.deepEqual(union[union.length - 1], {
    name: untrackedLeg[untrackedLeg.length - 1],
    untracked: true,
  });
});

// ---------------------------------------------------------------------------
// SPGD-1273: the changed-mode directory fence. `--changed` — the mode the
// README documents as CI selection — applied NO fence at all:
// `SKIPPED_DIRECTORIES` was applied only inside walk()'s directory
// recursion, and the false premise "`--exclude-standard` is the boundary"
// was written into three prose surfaces. It structurally cannot carry that
// boundary: it is an argument to `git ls-files --others` and exists only on
// the untracked leg, while git never applies ignore rules to tracked files —
// so a dependency-bump PR that commits a vendored file was failed over code
// the user did not write and cannot edit. The fence now applies to the
// materialized union inside selectChanged's loop — ONE placement covers both
// legs — the removal count rides `FileSelection.skipped`, the checked-count
// line discloses it count-gated, and a fence-emptied selection names the
// fence instead of a wrong cause. Fence directory names are spelled as
// literals below: a pin reading its expectation off `SKIPPED_DIRECTORIES`
// could never fail.
// ---------------------------------------------------------------------------

test("a tracked annotated file under a fenced directory is excluded from the DIFF leg, and the removal is counted", () => {
  const f = initRepo({ "src/a.ts": GOOD_ANNOTATION });
  commitAll(f, "base");
  git(f.root, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(f.root, "src/a.ts"), GOOD_ANNOTATION + "\n// touched\n");
  fs.mkdirSync(path.join(f.root, "dist/generated"), { recursive: true });
  fs.writeFileSync(path.join(f.root, "dist/generated/bundle.js"), BAD_ANNOTATION);
  fs.mkdirSync(path.join(f.root, "coverage/lcov-report"), { recursive: true });
  fs.writeFileSync(path.join(f.root, "coverage/lcov-report/prettify.js"), BAD_ANNOTATION);
  commitAll(f, "commit build output carrying malformed annotations");

  const selection = selectFiles([], f.root, { changed: true });
  assert.deepEqual(selection.files, ["src/a.ts"]);
  // `untracked === 0` proves the fenced files arrived via the DIFF leg: the
  // leg `.gitignore`/`--exclude-standard` never touches — these files are
  // committed, and nothing here ignores `dist/` or `coverage/`. Before the
  // fence this exact tree selected all three and failed the run.
  assert.deepEqual(
    selection.stats,
    { changed: 3, matches: 3, outsideRoot: 0, unreadable: 0, untracked: 0 },
  );
  assert.equal(selection.skipped, 2);
});

test("an untracked annotated file under a fenced directory is excluded even where no .gitignore covers it", () => {
  const f = initRepo({ "src/a.ts": GOOD_ANNOTATION });
  commitAll(f, "base");
  git(f.root, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(f.root, "src/a.ts"), GOOD_ANNOTATION + "\n// touched\n");
  // No .gitignore covers dist/: `--exclude-standard` leaves the file on the
  // untracked leg, so the fence — not git — is what removes it.
  fs.mkdirSync(path.join(f.root, "dist/generated"), { recursive: true });
  fs.writeFileSync(path.join(f.root, "dist/generated/untracked.js"), BAD_ANNOTATION);
  // Precondition: the file demonstrably entered the union (git offers it).
  assert.match(
    git(f.root, "ls-files", "--others", "--exclude-standard"),
    /dist\/generated\/untracked\.js/,
  );

  const selection = selectFiles([], f.root, { changed: true });
  assert.deepEqual(selection.files, ["src/a.ts"]);
  // Counted in `matches` — it entered the union and was removed by the
  // fence, never absent from it — and `untracked` reads 0 because leg
  // attribution happens at selection, after the fence arm.
  assert.equal(selection.stats?.matches, 2);
  assert.equal(selection.stats?.untracked, 0);
  assert.equal(selection.skipped, 1);
});

test("the fence matches whole segments and never the basename: src/dist_helpers/a.ts and src/coverage.ts are still selected", () => {
  const f = initRepo({ "src/a.ts": GOOD_ANNOTATION });
  commitAll(f, "base");
  git(f.root, "checkout", "-b", "feature");
  fs.mkdirSync(path.join(f.root, "src/dist_helpers"), { recursive: true });
  fs.writeFileSync(path.join(f.root, "src/dist_helpers/a.ts"), GOOD_ANNOTATION);
  fs.writeFileSync(path.join(f.root, "src/coverage.ts"), GOOD_ANNOTATION);
  commitAll(f, "project code whose names merely resemble fenced words");

  const selection = selectFiles([], f.root, { changed: true });
  // A substring or basename-inclusive match would fence both of these.
  assert.deepEqual(selection.files, ["src/coverage.ts", "src/dist_helpers/a.ts"]);
  assert.equal(selection.skipped, 0);
});

test("the walk fences the directory ENTRY by exact name only: src/dist_helpers/ is walked and src/coverage.ts is selected", () => {
  const f = makeRepo({
    "src/a.ts": GOOD_ANNOTATION,
    "src/dist_helpers/a.ts": GOOD_ANNOTATION,
    "src/coverage.ts": GOOD_ANNOTATION,
  });

  // Walk mode IS the point: the pin above drives the same three files
  // through `--changed`, where `skippedDirectory()` decides at path level,
  // while the bare invocation decides here at the recursion's directory
  // entry (`!SKIPPED_DIRECTORIES.has(entry.name)`). That entry check is the
  // one shape the pin above cannot see: a substring or basename-inclusive
  // match creeping into it would prune BOTH of these files from the walk —
  // `dist_helpers` contains "dist", and so does the basename `coverage.ts`
  // contain "coverage" — while `--changed` on the same tree still selects
  // them.
  const selection = selectFiles([], f.root);
  assert.equal(selection.mode, "walk");
  // Literal paths, never derived from SKIPPED_DIRECTORIES: a pin reading its
  // expectation off the constant mutates with it and can never fail.
  assert.deepEqual(
    selection.files.map((p) => path.relative(f.root, p)).sort(),
    ["src/a.ts", "src/coverage.ts", "src/dist_helpers/a.ts"],
  );
});

// ---------------------------------------------------------------------------
// SPGD-1336: the fence's two HIDDEN members (`.git`, `.test-build`). The three
// visible members are densely driven — deleting `dist` alone reddens seven
// examples — while deleting BOTH hidden members from `SKIPPED_DIRECTORIES`
// left the entire suite green at either application site. The Ruby twin's
// spec reasons about "its TypeScript twin" when it pins the pair, which reads
// as though both sides were covered; they were not, and the divergence is
// real rather than cosmetic: Ruby walks with `Dir.glob` WITHOUT
// `File::FNM_DOTMATCH`, so hidden directories are structurally unreachable
// there, while `fs.readdirSync(dir, { withFileTypes: true })` DOES return
// hidden entries — here the fence is the only thing keeping a build artifact
// out of the selection. Driven against the real selector, removing the pair
// selects `.test-build/generated/out.js` and lints it, which is the
// false-exit-1-over-code-the-user-cannot-edit defect this fence family exists
// to remove (SPGD-1254/1255/1273). Both directory names are spelled as
// LITERALS below: a pin deriving its expectation from `SKIPPED_DIRECTORIES`
// mutates with the constant and can never fail — the self-validating-pin trap
// the Ruby spec's own comment warns about verbatim.
// ---------------------------------------------------------------------------

test("the walk fences the HIDDEN members .git and .test-build, which readdirSync does return", () => {
  // `withFileTypes` enumeration is dot-inclusive, so each of these annotated
  // files is genuinely offered to the walk and genuinely removed by the
  // fence — unlike the Ruby twin, where the glob never sees them at all.
  const f = makeRepo({
    "src/a.ts": GOOD_ANNOTATION,
    ".git/hooks/prepare-commit-msg.js": BAD_ANNOTATION,
    ".test-build/test/lint.test.js": BAD_ANNOTATION,
    ".test-build/generated/out.js": BAD_ANNOTATION,
    "node_modules/pkg/index.js": BAD_ANNOTATION,
  });
  // Precondition: the hidden directories are reachable at the walk's own
  // primitive. Without this the pin could pass on a dot-blind enumeration,
  // asserting nothing about the fence.
  const topLevelEntries = fs
    .readdirSync(f.root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(topLevelEntries, [".git", ".test-build", "node_modules", "src"]);

  const selection = selectFiles([], f.root);
  assert.equal(selection.mode, "walk");
  assert.deepEqual(
    selection.files.map((p) => path.relative(f.root, p)).sort(),
    ["src/a.ts"],
  );
});

test("the changed leg fences a COMMITTED file under the hidden .test-build directory, and counts the removal", () => {
  // `.git` cannot travel this leg — git does not track its own directory —
  // so `.test-build` is the hidden member the counted `--changed` arm can
  // carry, and it is carried on the DIFF leg (committed, so
  // `--exclude-standard` never touches it).
  const f = initRepo({ "src/a.ts": GOOD_ANNOTATION });
  commitAll(f, "base");
  git(f.root, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(f.root, "src/a.ts"), GOOD_ANNOTATION + "\n// touched\n");
  fs.mkdirSync(path.join(f.root, ".test-build/generated"), { recursive: true });
  fs.writeFileSync(path.join(f.root, ".test-build/generated/out.js"), BAD_ANNOTATION);
  // `-f`: a repository that ignores its own compiled test output would keep
  // the file off both legs, and the pin would assert nothing.
  git(f.root, "add", "-A", "-f");
  git(f.root, "commit", "-m", "commit compiled test output carrying a malformed annotation");
  // Precondition: the path is tracked, so it really does arrive via the diff.
  assert.match(git(f.root, "ls-files"), /\.test-build\/generated\/out\.js/);

  const selection = selectFiles([], f.root, { changed: true });
  assert.deepEqual(selection.files, ["src/a.ts"]);
  // Counted, not merely absent: the hidden member travels the same counted
  // fence arm the visible members do.
  assert.equal(selection.skipped, 1);
  assert.deepEqual(
    selection.stats,
    { changed: 2, matches: 2, outsideRoot: 0, unreadable: 0, untracked: 0 },
  );
});

test("a zero-fence changed selection is unchanged, and the skipped count defaults to 0 at every construction site", () => {
  // Mixed-shape changed run with nothing fenced: both legs contribute, the
  // count reads 0.
  const mixed = initRepo({ "src/a.ts": GOOD_ANNOTATION });
  commitAll(mixed, "base");
  git(mixed.root, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(mixed.root, "src/a.ts"), GOOD_ANNOTATION + "\n// touched\n");
  fs.writeFileSync(path.join(mixed.root, "src/new.ts"), GOOD_ANNOTATION);
  const selection = selectFiles([], mixed.root, { changed: true });
  assert.deepEqual(selection.files, ["src/a.ts", "src/new.ts"]);
  assert.equal(selection.skipped, 0);

  // `skipped` follows the `base`/`note`/`stats` precedent: defaulted 0 at
  // the walk and explicit sites, which never count a file-level removal.
  assert.equal(selectFiles([], mixed.root).skipped, 0);
  assert.equal(selectFiles(["src/a.ts"], mixed.root).skipped, 0);
});

test("a changed run whose fence removed files discloses the count on the checked-count line; the json selection block keeps its shape", () => {
  const f = initRepo({ "src/a.ts": GOOD_ANNOTATION });
  commitAll(f, "base");
  git(f.root, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(f.root, "src/a.ts"), GOOD_ANNOTATION + "\n// touched\n");
  fs.mkdirSync(path.join(f.root, "dist/generated"), { recursive: true });
  fs.writeFileSync(path.join(f.root, "dist/generated/bundle.js"), BAD_ANNOTATION);
  commitAll(f, "touch src, commit a vendored file");

  const binary = stubBackend([{ file: "src/a.ts", line: 1, kind: null, ok: true, errors: [] }], 1);
  const report = inRepo(f, [], binary, { changed: true });
  assert.equal(report.exitCode, EXIT_OK);
  const human = renderHuman(report);
  // Count-gated exactly like the `including N untracked` clause beside it.
  assert.match(
    human,
    /checked 1 source file changed since \S+ skipping 1 in dependency or build directories/,
  );

  // The json selection block keeps its exact shape (mode, base, note) — the
  // disclosure rides the human line (and json-mode's stderr bridge), not a
  // new document key.
  const json = JSON.parse(renderJson(report)) as { selection?: Record<string, unknown> };
  assert.deepEqual(Object.keys(json.selection ?? {}), ["mode", "base", "note"]);
});

test("a changed selection emptied entirely by the fence reports the fence, not a wrong cause", () => {
  // Every matching file the diff produced lives under dist/: before the
  // honest reason this fell through the ladder to "could not be read" —
  // a conclusion that stops the reader looking, the exact failure the
  // empty-reason ladder exists to prevent.
  const f = initRepo({ "src/a.ts": GOOD_ANNOTATION });
  commitAll(f, "base");
  git(f.root, "checkout", "-b", "feature");
  fs.mkdirSync(path.join(f.root, "dist/generated"), { recursive: true });
  fs.writeFileSync(path.join(f.root, "dist/generated/bundle.js"), BAD_ANNOTATION);
  commitAll(f, "only build output changed");

  const cli = runCliInRepo(f, ["lint", "--changed"]);
  assert.equal(cli.exit, EXIT_OK);
  assert.match(
    cli.stderr,
    /selected 0 annotated source files — 1 changed annotated-source file against \S+, all in dependency or build directories/,
  );
  assert.ok(!cli.stderr.includes("nothing changed against"), cli.stderr);
  assert.ok(!cli.stderr.includes("none matching the annotated extensions"), cli.stderr);
  assert.ok(!cli.stderr.includes("could not be read"), cli.stderr);
  // And the checked-count line discloses the removal beside the reason.
  assert.match(cli.stdout, /skipping 1 in dependency or build directories/);
});

// SPGD-1295's arithmetic pin, mirroring the Ruby twin's landed SPGD-1293
// shape: with BOTH causes present the sentence names each with its own
// count and the counts SUM to the matched total — the pre-fix sentence
// prefixed the matched count onto the unreadable clause and read
// "5 … could not be read and 3 in dependency" against 5 matched files.
// The lopsided 2/3 counts also catch a swap of the two counters, which an
// equal-count fixture cannot distinguish.
test("a changed selection emptied by both the unreadable files and the fence carries each cause's own count", () => {
  const f = initRepo({ "src/a.ts": GOOD_ANNOTATION });
  commitAll(f, "base");
  git(f.root, "checkout", "-b", "feature");
  // Two dangling symlinks (the `unreadable` branch — matched, in-root, and
  // not an existing regular file) and three vendored sources (the fence
  // branch), all under the repo root so `outsideRoot` stays at zero — the
  // two-cause arm, with counts too lopsided to alias.
  fs.symlinkSync("missing_target.ts", path.join(f.root, "src/broken_one.ts"));
  fs.symlinkSync("missing_target.ts", path.join(f.root, "src/broken_two.ts"));
  fs.mkdirSync(path.join(f.root, "dist/generated"), { recursive: true });
  fs.writeFileSync(path.join(f.root, "dist/generated/gen_zero.js"), BAD_ANNOTATION);
  fs.writeFileSync(path.join(f.root, "dist/generated/gen_one.js"), BAD_ANNOTATION);
  fs.writeFileSync(path.join(f.root, "dist/generated/gen_two.js"), BAD_ANNOTATION);
  commitAll(f, "add broken symlink sources and generated sources");

  const cli = runCliInRepo(f, ["lint", "--changed"]);
  assert.equal(cli.exit, EXIT_OK);
  assert.match(
    cli.stderr,
    /selected 0 annotated source files — 5 changed annotated-source files against \S+, but 2 could not be read and 3 in dependency or build directories/,
  );
  // Negative matcher on the defective junction: the matched total followed
  // straight by "could not be read" is the pre-fix lie (5 could not be
  // read), never the corrected sentence's shape.
  assert.doesNotMatch(cli.stderr, /against \S+ could not be read and 3 in dependency/);
  // And the checked-count line discloses the fence's share beside the reason.
  assert.match(cli.stdout, /skipping 3 in dependency or build directories/);
});

// SPGD-1309's two remaining empty-reason pins. The outsideRoot arm builds its
// sentence by APPENDING the other two causes (`if (stats.unreadable > 0) …`,
// `if (skipped > 0) …`), and the ladder's last arm names the unreadable count
// with no appendage at all — three optional pieces of the same sentence
// family, none of which had a driver: deleting either appendage, or renaming
// the fall-through's phrase, left the whole suite green. The omission
// direction is the one the call site's contract forbids: a sentence that
// names one cause and silently drops the others reads as a conclusion and
// stops the reader looking, the exact arithmetic deception SPGD-1293/1295
// already fixed one arm over.
test("a changed selection excluded by all three causes names each one with its own count", () => {
  const f = initRepo({
    "packages/app/src/a.ts": GOOD_ANNOTATION,
    "other/b.ts": GOOD_ANNOTATION,
  });
  commitAll(f, "base");
  git(f.root, "checkout", "-b", "feature");
  // One annotated file outside the run directory (the `outsideRoot` branch),
  // two dangling symlinks inside it (the `unreadable` branch: matched,
  // in-root, and not an existing regular file), and three vendored sources
  // (the fence branch). Counts are lopsided 1/2/3 so a swap of any two
  // counters cannot alias — the lesson SPGD-1295's own 2/3 fixture carried.
  fs.writeFileSync(path.join(f.root, "other/b.ts"), GOOD_ANNOTATION + "\n// touched\n");
  fs.symlinkSync("missing_target.ts", path.join(f.root, "packages/app/src/broken_one.ts"));
  fs.symlinkSync("missing_target.ts", path.join(f.root, "packages/app/src/broken_two.ts"));
  fs.mkdirSync(path.join(f.root, "packages/app/dist/generated"), { recursive: true });
  for (const name of ["gen_zero.js", "gen_one.js", "gen_two.js"]) {
    fs.writeFileSync(path.join(f.root, "packages/app/dist/generated", name), BAD_ANNOTATION);
  }
  commitAll(f, "touch other/, add broken symlink sources and generated sources");

  const cli = runCliInRepo(f, ["lint", "--changed"], path.join(f.root, "packages/app"));
  assert.equal(cli.exit, EXIT_OK);
  // All three clauses, each carrying its OWN count, in the ladder's order —
  // and the three counts sum to the matched total (1 + 2 + 3 === 6).
  assert.match(
    cli.stderr,
    /selected 0 annotated source files — 6 changed annotated-source files against \S+, but 1 is outside \S+ \(--changed selects only files under the current directory\) and 2 could not be read and 3 in dependency or build directories/,
  );
  // And the checked-count line discloses the fence's share beside the reason.
  assert.match(cli.stdout, /skipping 3 in dependency or build directories/);
});

test("a changed selection emptied only by unreadable files names that cause alone", () => {
  // The ladder's fall-through: nothing outside the root and nothing fenced,
  // so `unreadable` is the only filter left and the sentence carries no
  // appended clause. Its phrasing is load-bearing all the same — this is the
  // arm every other arm's negative matcher is written against.
  const f = initRepo({ "src/a.ts": GOOD_ANNOTATION });
  commitAll(f, "base");
  git(f.root, "checkout", "-b", "feature");
  fs.symlinkSync("missing_target.ts", path.join(f.root, "src/broken_one.ts"));
  fs.symlinkSync("missing_target.ts", path.join(f.root, "src/broken_two.ts"));
  commitAll(f, "add broken symlink sources only");

  const cli = runCliInRepo(f, ["lint", "--changed"]);
  assert.equal(cli.exit, EXIT_OK);
  assert.match(
    cli.stderr,
    /selected 0 annotated source files — 2 changed annotated-source files against \S+ could not be read/,
  );
  // Negative matchers on the neighbouring arms: this sentence must not drift
  // into a shape that names a cause this run does not have.
  assert.ok(!cli.stderr.includes("in dependency or build directories"), cli.stderr);
  assert.ok(!cli.stderr.includes("is outside"), cli.stderr);
  assert.ok(!cli.stderr.includes("are outside"), cli.stderr);
  // Nothing was fenced, so the checked-count line carries no skip disclosure.
  assert.ok(!cli.stdout.includes("skipping"), cli.stdout);
});

// ---------------------------------------------------------------------------
// SPGD-1144: the selection sentence under `--json`. The provenance line the
// human report writes was constructed inside renderHuman only, so a json-mode
// `--changed` run named its selection nowhere a machine can read: the document
// carries `{mode, base, note}` only and the run's stderr was empty. The
// specguard-mcp bridge passes `--json` unconditionally and forwards stderr
// verbatim as `linter_stderr`, so the sentence branches by STREAM, not by
// content: one builder (`provenanceLine`) renders it for both renderers —
// the human report keeps stdout byte-identical, json mode reads the same
// bytes on stderr.
// ---------------------------------------------------------------------------

/** The mixed tree all three SPGD-1144 pins run over: one tracked-and-modified
 * spec plus one never-`git add`ed spec — the untracked leg demonstrably
 * contributing to the selection. */
function mixedTreeFixture(untrackedBody: string): Fixture {
  const f = initRepo({ "src/a.ts": GOOD_ANNOTATION });
  commitAll(f, "base");
  git(f.root, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(f.root, "src/a.ts"), GOOD_ANNOTATION + "\n// touched\n");
  fs.writeFileSync(path.join(f.root, "src/new_untracked.ts"), untrackedBody);
  return f;
}

test("a json-mode --changed run over a mixed tree carries the selection sentence on stderr; stdout stays one clean document", () => {
  const f = mixedTreeFixture(GOOD_ANNOTATION);
  const binary = stubBackend(
    [
      { file: "src/a.ts", line: 1, kind: null, ok: true, errors: [] },
      { file: "src/new_untracked.ts", line: 1, kind: null, ok: true, errors: [] },
    ],
    2,
  );
  const cli = runCliInRepo(f, ["lint", "--changed", "--json"], f.root, binary);
  assert.equal(cli.exit, EXIT_OK);

  // The sentence on stderr, byte-exact, as the stream's LAST line — the order
  // the Ruby twin prints on its json stderr (provenance line, then sentence).
  const base = git(f.root, "merge-base", "HEAD", "main").trim();
  const sentence =
    `specguard lint: checked 2 source files changed since ${base} including 1 untracked`;
  const errLines = cli.stderr.trimEnd().split("\n");
  assert.equal(errLines[errLines.length - 1], sentence);
  // Exactly one checked line reaches stderr — the sentence itself; the
  // provenance line names no count and no warning fires (note is null here).
  assert.equal(errLines.filter((l) => l.startsWith("specguard lint: checked")).length, 1);

  // stdout stays exactly one JSON document carrying no `checked` prose.
  const json = JSON.parse(cli.stdout) as {
    summary: { files: number };
    selection?: { mode: string };
  };
  assert.equal(json.summary.files, 2);
  assert.equal(json.selection?.mode, "changed");
  assert.ok(
    !cli.stdout.includes("checked"),
    `human prose leaked into the json stdout:\n${cli.stdout}`,
  );

  // Walk mode emits nothing: the sentence is `changed` mode's own disclosure
  // (the mode clause of the emission guard), in human and json alike.
  const walked = runCliInRepo(f, ["lint", "--json"], f.root, binary);
  assert.equal(walked.exit, EXIT_OK);
  assert.ok(
    !walked.stderr.includes("specguard lint: checked"),
    `the sentence leaked into a walk-mode json stderr:\n${walked.stderr}`,
  );
});

test("a json-mode --changed run with a malformed annotation: exit 1 and the sentence still rides stderr", () => {
  const f = mixedTreeFixture(BAD_ANNOTATION);
  const binary = stubBackend(
    [
      { file: "src/a.ts", line: 1, kind: null, ok: true, errors: [] },
      { file: "src/new_untracked.ts", line: 1, kind: "schema", ok: false, errors: ["entity: is missing"] },
    ],
    2,
    1,
  );
  const cli = runCliInRepo(f, ["lint", "--changed", "--json"], f.root, binary);
  assert.equal(cli.exit, EXIT_MALFORMED);
  const base = git(f.root, "merge-base", "HEAD", "main").trim();
  assert.match(
    cli.stderr,
    new RegExp(`checked 2 source files changed since ${base} including 1 untracked`),
  );
  // An exit-1 run still emits its document — and the document carries no
  // `checked` prose; the sentence's home is stderr alone.
  const json = JSON.parse(cli.stdout) as { ok: boolean };
  assert.equal(json.ok, false);
  assert.ok(!cli.stdout.includes("checked"));
});

test("human mode keeps the sentence as stdout's first line, byte-identical, and stderr carries no checked line", () => {
  const f = mixedTreeFixture(GOOD_ANNOTATION);
  const binary = stubBackend(
    [
      { file: "src/a.ts", line: 1, kind: null, ok: true, errors: [] },
      { file: "src/new_untracked.ts", line: 1, kind: null, ok: true, errors: [] },
    ],
    2,
  );
  const cli = runCliInRepo(f, ["lint", "--changed"], f.root, binary);
  assert.equal(cli.exit, EXIT_OK);
  // Byte-equality of the sentence: the extracted builder's output is the
  // human report's first line exactly as it was before the extraction.
  const base = git(f.root, "merge-base", "HEAD", "main").trim();
  assert.ok(
    cli.stdout.startsWith(
      `specguard lint: checked 2 source files changed since ${base} including 1 untracked\n`,
    ),
    `the human first line changed:\n${cli.stdout.split("\n")[0]}`,
  );
  // Human mode does NOT move the sentence to stderr: it is stdout's line
  // there; stderr carries the linter's own diagnostics only.
  assert.ok(
    !cli.stderr.includes("checked"),
    `a checked line leaked into human-mode stderr:\n${cli.stderr}`,
  );
});

// ---------------------------------------------------------------------------
// SPGD-1161: the zero-annotation coverage note. `specguard lint` had the
// blind spot its Ruby twin cured (SPGD-1159): a file that was read, reached
// the binary, and carries no `@intent` annotation is named NOWHERE — the
// human summary line interpolates the annotation COUNT and the json document
// carries findings only, so "every checked file annotated and valid" is
// byte-identical to "half the checked files carry nothing". The note composes
// into the report's `stderr` array — which cli.ts writes to stderr BEFORE
// rendering, so one composition reaches both renderers — as
// `specguard lint: note: N of M checked source file(s) carry/carries no
// @intent annotations: <files>`, a set-difference of `selection.files` minus
// BOTH the annotation-site findings (valid OR malformed: a malformed
// annotation IS an annotation site) AND the file-shaped-failure files
// (`read` / `no-match` — the run could not look inside them, and naming them
// annotation-free would overstate: an unread file is NOT a zero-annotation
// file). The prefix deliberately avoids `specguard lint:
// checked`, which the selection-sentence pins count; and the note composes
// BEFORE `jsonProvenance` so the selection sentence stays the stream's LAST
// line in every mode (the byte-exact SPGD-1144 pin). A file-shaped failure
// does NOT suppress the note — SPGD-1167 hoisted the composition above the
// exit-2 arm: the composition precedes the arm, and the arm composes the
// note between `stderrHead` and `jsonProvenance`, beside its error line, so
// a bare file checked alongside an unreadable one is named while an
// unreadable-only run still emits none (nothing bare to name) — and zero
// output changes when every checked file carries an annotation.
// ---------------------------------------------------------------------------

/** The stub findings for one annotation site on `file`, plus its count. */
function siteFinding(file: string, kind: string | null, ok: boolean): unknown[] {
  return [{ file, line: 1, kind, ok, errors: ok ? [] : ["entity: is missing"] }];
}

test("a mixed selection names exactly the bare file(s) on stderr in human mode, and none that is annotated", () => {
  const f = makeRepo({
    "annotated.test.ts": GOOD_ANNOTATION + "\nit('x', () => {});",
    "bare.test.ts": "it('y', () => {});\n",
  });
  const binary = stubBackend(siteFinding("annotated.test.ts", null, true), 1);
  const cli = runCliInRepo(f, ["lint", "annotated.test.ts", "bare.test.ts"], f.root, binary);
  assert.equal(cli.exit, EXIT_OK);
  assert.ok(
    cli.stderr.includes(
      "specguard lint: note: 1 of 2 checked source files carries no @intent annotations: bare.test.ts",
    ),
    `the note naming the bare file is missing:\n${cli.stderr}`,
  );
  assert.ok(
    !cli.stderr.includes("annotated.test.ts"),
    `the annotated file was named:\n${cli.stderr}`,
  );
  // Human STDOUT is untouched: the note's home is stderr alone (the summary
  // line still interpolates the count, never the files).
  assert.ok(!cli.stdout.includes("no @intent annotations"));
});

test("a mixed selection names them on stderr in json mode too, leaving the document untouched", () => {
  const f = makeRepo({
    "annotated.test.ts": GOOD_ANNOTATION + "\nit('x', () => {});",
    "bare.test.ts": "it('y', () => {});\n",
  });
  const binary = stubBackend(siteFinding("annotated.test.ts", null, true), 1);
  const cli = runCliInRepo(
    f,
    ["lint", "--json", "annotated.test.ts", "bare.test.ts"],
    f.root,
    binary,
  );
  assert.equal(cli.exit, EXIT_OK);
  assert.ok(
    cli.stderr.includes(
      "specguard lint: note: 1 of 2 checked source files carries no @intent annotations: bare.test.ts",
    ),
    `the note naming the bare file is missing:\n${cli.stderr}`,
  );
  // The json document's key set and shape are byte-identical to today
  // (the SPGD-858 parity fence: no document key — stderr is the channel).
  const json = JSON.parse(cli.stdout) as {
    mode: string;
    ok: boolean;
    backend: unknown;
    summary: Record<string, unknown>;
    findings: { file: string }[];
  };
  assert.deepEqual(Object.keys(json), ["mode", "ok", "backend", "summary", "findings"]);
  assert.deepEqual(json.summary, { files: 2, annotations: 1, malformed: 0, unreadable: 0 });
  assert.deepEqual(
    json.findings.map((x) => x.file),
    ["annotated.test.ts"],
  );
  assert.ok(!cli.stdout.includes("no @intent annotations"));
});

test("several bare files are named together, plural verb, in selection order", () => {
  const f = makeRepo({
    "a.test.ts": GOOD_ANNOTATION + "\nit('x', () => {});",
    "b.test.ts": "it('y', () => {});\n",
    "c.test.ts": "it('z', () => {});\n",
  });
  const binary = stubBackend(siteFinding("a.test.ts", null, true), 1);
  const report = inRepo(f, ["a.test.ts", "b.test.ts", "c.test.ts"], binary);
  assert.equal(report.exitCode, EXIT_OK);
  assert.deepEqual(
    report.stderr,
    [
      `specguard lint: validated by ${binary} (validate-intent stub (test) schema sha256:${GOOD})`,
      "specguard lint: note: 2 of 3 checked source files carry no @intent annotations: b.test.ts, c.test.ts",
    ],
  );
});

test("a fully annotated selection emits no note — stderr is byte-identical to today in both modes", () => {
  const f = makeRepo({
    "first.test.ts": GOOD_ANNOTATION + "\nit('x', () => {});",
    "second.test.ts": GOOD_ANNOTATION + "\nit('y', () => {});",
  });
  const binary = stubBackend(
    [
      { file: "first.test.ts", line: 1, kind: null, ok: true, errors: [] },
      { file: "second.test.ts", line: 1, kind: null, ok: true, errors: [] },
    ],
    2,
  );
  const validatedBy = `specguard lint: validated by ${binary} (validate-intent stub (test) schema sha256:${GOOD})`;
  // Human mode: stderr is exactly the validated-by line, as before.
  const report = inRepo(f, ["first.test.ts", "second.test.ts"], binary);
  assert.equal(report.exitCode, EXIT_OK);
  assert.deepEqual(report.stderr, [validatedBy]);
  assert.ok(!renderHuman(report).includes("note:"));
  // Json mode: the same single stderr line; the document unchanged.
  const cli = runCliInRepo(f, ["lint", "--json", "first.test.ts", "second.test.ts"], f.root, binary);
  assert.equal(cli.exit, EXIT_OK);
  assert.equal(cli.stderr, `${validatedBy}\n`);
  const json = JSON.parse(cli.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(json), ["mode", "ok", "backend", "summary", "findings"]);
});

test("the note composes before the json provenance sentence, which stays the stream's LAST line", () => {
  // Changed mode, json: the ordering constraint the SPGD-1144 byte pin
  // fixed. Mixed tree — the tracked spec is annotated, the untracked one
  // carries nothing — so the note has something to name. The tracked change
  // is COMMITTED so HEAD moves past the merge base: a clean-derived base
  // keeps the thin-base warning out of the stream and the ordering exact.
  const f = initRepo({ "src/a.ts": GOOD_ANNOTATION });
  commitAll(f, "base");
  git(f.root, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(f.root, "src/a.ts"), GOOD_ANNOTATION + "\n// touched\n");
  commitAll(f, "touch a.ts");
  fs.writeFileSync(path.join(f.root, "src/new_untracked.ts"), "const bare = true;\n");
  const binary = stubBackend(siteFinding("src/a.ts", null, true), 1);
  const cli = runCliInRepo(f, ["lint", "--changed", "--json"], f.root, binary);
  assert.equal(cli.exit, EXIT_OK);
  const errLines = cli.stderr.trimEnd().split("\n");
  const base = git(f.root, "merge-base", "HEAD", "main").trim();
  assert.equal(
    errLines[errLines.length - 1],
    `specguard lint: checked 2 source files changed since ${base} including 1 untracked`,
  );
  assert.equal(
    errLines[1],
    "specguard lint: note: 1 of 2 checked source files carries no @intent annotations: src/new_untracked.ts",
  );
  // Walk mode, human: no provenance sentence exists there, and the note is
  // still exactly one line.
  const walked = runCliInRepo(f, ["lint", "--changed"], f.root, binary);
  assert.equal(walked.exit, EXIT_OK);
  const humanErrLines = walked.stderr.trimEnd().split("\n");
  assert.equal(humanErrLines.length, 2);
  assert.match(humanErrLines[1]!, /^specguard lint: note: 1 of 2 checked source files carries/);
});

test("a malformed-annotated file is never named bare — its annotation site subtracts it", () => {
  const f = makeRepo({
    "malformed.test.ts": BAD_ANNOTATION + "\nit('x', () => {});",
    "bare.test.ts": "it('y', () => {});\n",
  });
  const binary = stubBackend(siteFinding("malformed.test.ts", "schema", false), 1);
  const report = inRepo(f, ["malformed.test.ts", "bare.test.ts"], binary);
  assert.equal(report.exitCode, EXIT_MALFORMED);
  // Exit 1 still reports: the note composes on the normal-path return, and
  // the malformed file is an annotation site, not a bare one.
  const noteLines = report.stderr.filter((l) => l.startsWith("specguard lint: note:"));
  assert.deepEqual(noteLines, [
    "specguard lint: note: 1 of 2 checked source files carries no @intent annotations: bare.test.ts",
  ]);
  // The malformed file's name appears on no stderr line at all: it is
  // subtracted from the set by its own annotation-site finding.
  assert.ok(!report.stderr.join("\n").includes("malformed.test.ts"));
});

// SPGD-1167: this pin MOVED DELIBERATELY (the SPGD-1108 disclosed-move
// pattern). It landed with SPGD-1161 as the silence pin freezing the
// over-applied boundary: any file-shaped failure and the whole note
// vanished. The Ruby contract it cites (SPGD-1159, "never names an unread
// file") is about not NAMING the unread file — "naming it annotation-free
// would overstate exactly the way the summary count refuses to" — never
// about suppressing the note for the files checked alongside it, and the
// identical mixed scenario passes on the Ruby side with the note naming the
// bare file. The "never named" clause below is unchanged and still true for
// the unreadable file; the "NO note composes" clause is what the port
// over-applied, and it now asserts the Ruby contract: the note names
// bare.test.ts and never gone.test.ts, beside the unchanged unread error
// line and the unchanged exit-2 arm.
test("a mixed run names the bare file and never the unreadable one; the unread error line and exit-2 arm pass unedited", () => {
  const f = makeRepo({ "bare.test.ts": "it('y', () => {});\n" });
  const binary = stubBackend(
    [{ file: "gone.test.ts", kind: "no-match", ok: false, errors: ["no file(s) match"] }],
    0,
  );
  const report = inRepo(f, ["bare.test.ts", "gone.test.ts"], binary);
  assert.equal(report.exitCode, EXIT_MISUSE);
  // The whole stream, byte-pinned: the note composes between the
  // validated-by head and the unread error line (the same relative position
  // it holds on the normal path), and the error line itself is untouched.
  assert.deepEqual(report.stderr, [
    `specguard lint: validated by ${binary} (validate-intent stub (test) schema sha256:${GOOD})`,
    "specguard lint: note: 1 of 2 checked source files carries no @intent annotations: bare.test.ts",
    "specguard lint: error: 1 file(s) could not be read: gone.test.ts",
  ]);
});

// SPGD-1167 additive pins.

test("an unreadable-only run emits no note — stderr and exit are byte-identical to today", () => {
  // No bare files exist, so the note has nothing to name and the hoisted
  // composition renders nothing: with the sole selected file unreadable,
  // bare is empty and coverageNote is null. (gone.test.ts never exists on
  // disk — the stub reports the read failure.)
  const f = makeRepo({});
  const binary = stubBackend(
    [{ file: "gone.test.ts", kind: "no-match", ok: false, errors: ["no file(s) match"] }],
    0,
  );
  const report = inRepo(f, ["gone.test.ts"], binary);
  assert.equal(report.exitCode, EXIT_MISUSE);
  assert.deepEqual(report.stderr, [
    `specguard lint: validated by ${binary} (validate-intent stub (test) schema sha256:${GOOD})`,
    "specguard lint: error: 1 file(s) could not be read: gone.test.ts",
  ]);
});

test("a mixed json run names the bare file on stderr with the document untouched", () => {
  const f = makeRepo({ "bare.test.ts": "it('y', () => {});\n" });
  const binary = stubBackend(
    [{ file: "gone.test.ts", kind: "no-match", ok: false, errors: ["no file(s) match"] }],
    0,
  );
  const cli = runCliInRepo(f, ["lint", "--json", "bare.test.ts", "gone.test.ts"], f.root, binary);
  assert.equal(cli.exit, EXIT_MISUSE);
  assert.deepEqual(cli.stderr.trimEnd().split("\n"), [
    `specguard lint: validated by ${binary} (validate-intent stub (test) schema sha256:${GOOD})`,
    "specguard lint: note: 1 of 2 checked source files carries no @intent annotations: bare.test.ts",
    "specguard lint: error: 1 file(s) could not be read: gone.test.ts",
  ]);
  // Exit-2-with-findings still renders a document (cli.ts's render gate).
  // The SPGD-858 parity fence holds on the new arm: the note lives on
  // stderr; no document key moves and the summary keeps its shape.
  const json = JSON.parse(cli.stdout) as {
    ok: boolean;
    summary: Record<string, unknown>;
    findings: Array<Record<string, unknown>>;
  };
  assert.deepEqual(Object.keys(json), ["mode", "ok", "backend", "summary", "findings"]);
  assert.equal(json.ok, false);
  assert.deepEqual(json.summary, { files: 2, annotations: 0, malformed: 0, unreadable: 1 });
  assert.equal(json.findings.length, 1);
  assert.equal(json.findings[0]!["file"], "gone.test.ts");
  assert.equal(json.findings[0]!["ok"], false);
});

test("a mixed run with several bare files names them together, in selection order, never the unreadable one", () => {
  // The names are chosen so selection order and sorted order DIFFER
  // (b_bare before a_bare): the pin discriminates "selection order" from
  // "alphabetical" — the SPGD-1165 suite's plural pin could not.
  const f = makeRepo({
    "b_bare.test.ts": "it('b', () => {});\n",
    "a_bare.test.ts": "it('a', () => {});\n",
  });
  const binary = stubBackend(
    [{ file: "gone.test.ts", kind: "no-match", ok: false, errors: ["no file(s) match"] }],
    0,
  );
  const report = inRepo(f, ["b_bare.test.ts", "a_bare.test.ts", "gone.test.ts"], binary);
  assert.equal(report.exitCode, EXIT_MISUSE);
  const noteLines = report.stderr.filter((l) => l.startsWith("specguard lint: note:"));
  assert.deepEqual(noteLines, [
    "specguard lint: note: 2 of 3 checked source files carry no @intent annotations: b_bare.test.ts, a_bare.test.ts",
  ]);
  assert.ok(
    !noteLines.join("\n").includes("gone.test.ts"),
    `the note named the unreadable file:\n${report.stderr.join("\n")}`,
  );
});

// SPGD-1165: the singular arm of the note's pluralization, pinned byte-exact.
// The line's pluralization contract is two ternaries keyed on DIFFERENT
// sizes (lint.ts): the NOUN keys on the selection's TOTAL size
// (`file${selection.files.length === 1 ? "" : "s"}`), the VERB on the bare
// count (`${bare.length === 1 ? "carries" : "carry"}`). Every landed pin
// above selects at least two files, so the singular-noun arm — `1 of 1
// checked source file carries` — was machine-observable contract pinned
// nowhere: dropping the noun ternary left this suite all green while
// flipping the verb ternary turned four landed pins red (both directions
// measured on the base tree). These two pins select exactly ONE file so
// both arms render in their singular form, and hold the line exact-equal.

test("a one-file selection whose only file is bare names it with the singular noun and verb, byte-exact", () => {
  const f = makeRepo({ "bare.test.ts": "it('y', () => {});\n" });
  const binary = stubBackend([], 0);
  const report = inRepo(f, ["bare.test.ts"], binary);
  assert.equal(report.exitCode, EXIT_OK);
  assert.deepEqual(report.stderr, [
    `specguard lint: validated by ${binary} (validate-intent stub (test) schema sha256:${GOOD})`,
    "specguard lint: note: 1 of 1 checked source file carries no @intent annotations: bare.test.ts",
  ]);
});

test("a one-file selection renders the singular note on stderr in json mode, the document's zero-annotation shape intact", () => {
  const f = makeRepo({ "bare.test.ts": "it('y', () => {});\n" });
  const binary = stubBackend([], 0);
  const cli = runCliInRepo(f, ["lint", "--json", "bare.test.ts"], f.root, binary);
  assert.equal(cli.exit, EXIT_OK);
  assert.equal(
    cli.stderr,
    `specguard lint: validated by ${binary} (validate-intent stub (test) schema sha256:${GOOD})\n` +
      "specguard lint: note: 1 of 1 checked source file carries no @intent annotations: bare.test.ts\n",
  );
  // The json document keeps its one-file zero-annotation shape, asserted
  // with deepEqual exactly as the landed mixed-json pin does (the SPGD-858
  // parity fence: the note lives on stderr; no document key moves).
  const json = JSON.parse(cli.stdout) as {
    ok: boolean;
    summary: Record<string, unknown>;
    findings: unknown[];
  };
  assert.deepEqual(Object.keys(json), ["mode", "ok", "backend", "summary", "findings"]);
  assert.equal(json.ok, true);
  assert.deepEqual(json.summary, { files: 1, annotations: 0, malformed: 0, unreadable: 0 });
  assert.deepEqual(json.findings, []);
});

// ---------------------------------------------------------------------------
// SPGD-1027: shallow checkouts. A depth-1 CI clone (the actions/checkout@v4
// default) cannot answer the merge-base question — the merge base with the
// default branch is not in its history — so the derived base is HEAD itself,
// and the pre-shallow notes misattributed that to a "default-branch build".
// The notes must tell the shallow story and name the remedy; non-shallow
// output keeps its exact former text.
// ---------------------------------------------------------------------------

/** A depth-1 clone of a committed fixture — the default shallow CI shape:
 * `.git/shallow` present, the merge base with the default branch outside the
 * clone's history. The `file://` URL forces the smart transport: git WARNS
 * and IGNORES `--depth` on a plain local path (a local clone is always full). */
function shallowCloneOf(src: Fixture): Fixture {
  const dst = makeRepo({}); // an empty directory is a legal clone target
  git(src.root, "clone", "--depth", "1", `file://${src.root}`, dst.root);
  git(dst.root, "config", "user.email", "specguard-test@example.com");
  git(dst.root, "config", "user.name", "specguard-test");
  return dst;
}

function initShallowClone(files: Record<string, string>): Fixture {
  // The source needs history for depth 1 to CUT: git writes the `.git/shallow`
  // marker only when the clone actually truncates, so a one-commit source
  // yields a full clone that is not shallow at all.
  const src = initRepo(files);
  commitAll(src, "base");
  fs.writeFileSync(
    path.join(src.root, "README.md"),
    "# history filler so a depth-1 clone truncates\n",
  );
  commitAll(src, "second commit — the depth cut");
  return shallowCloneOf(src);
}

test("shallow clone, clean tree, --changed: exit 0 and the stderr note names the checkout as shallow with the remedy, never the default-branch-build guess (AC1)", () => {
  const f = initShallowClone({ "src/a.ts": GOOD_ANNOTATION });
  assert.equal(git(f.root, "rev-parse", "--is-shallow-repository").trim(), "true"); // the fixture is what it claims

  const cli = runCliInRepo(f, ["lint", "--changed"]);
  assert.equal(cli.exit, EXIT_OK);
  assert.match(
    cli.stderr,
    /specguard lint: warning: this checkout is a shallow \(depth-limited\) clone, so the merge base with the default branch is not in its history and the diff base is HEAD itself/,
  );
  assert.match(cli.stderr, /only uncommitted changes can be selected/);
  assert.match(cli.stderr, /fetch-depth: 0/);
  assert.match(cli.stderr, /--changed=<base>/);
  // The retired guess must not ride ANY stderr line of the run.
  assert.ok(
    !cli.stderr.includes("default-branch build"),
    `the retired "default-branch build" text appeared:\n${cli.stderr}`,
  );
});

test("shallow clone, clean tree, --changed --json: selection.note tells the same shallow story (AC1, json leg)", () => {
  const f = initShallowClone({ "src/a.ts": GOOD_ANNOTATION });
  const cli = runCliInRepo(f, ["lint", "--changed", "--json"]);
  assert.equal(cli.exit, EXIT_OK);
  const json = JSON.parse(cli.stdout) as { selection: { mode: string; note: string | null } };
  assert.equal(json.selection.mode, "changed");
  const note = json.selection.note ?? "";
  assert.match(note, /shallow \(depth-limited\) clone/);
  assert.match(note, /fetch-depth: 0/);
  assert.ok(!note.includes("default-branch build"));
});

test("shallow clone, --changed=<sha not in its history>: exit 2 naming the shallow cause and the fetch remedy (AC2)", () => {
  const src = initRepo({ "src/a.ts": GOOD_ANNOTATION });
  commitAll(src, "base");
  fs.writeFileSync(path.join(src.root, "README.md"), "# history filler\n");
  commitAll(src, "second commit — the depth cut"); // depth 1 must truncate something
  const f = shallowCloneOf(src);
  // A commit made in the source AFTER the clone: the depth-1 clone cannot
  // contain it, which is exactly what a stale/pinned base sha is in CI.
  fs.writeFileSync(path.join(src.root, "src/a.ts"), GOOD_ANNOTATION + "\n// later\n");
  commitAll(src, "later commit");
  const absentSha = git(src.root, "rev-parse", "HEAD").trim();

  const cli = runCliInRepo(f, ["lint", `--changed=${absentSha}`]);
  assert.equal(cli.exit, EXIT_MISUSE);
  assert.equal(cli.stdout, ""); // no report document on an exit-2 run
  assert.match(cli.stderr, new RegExp(`--changed could not diff against "${absentSha}"`));
  assert.match(cli.stderr, /this checkout is shallow and/);
  assert.match(cli.stderr, /is not in its history/);
  assert.match(cli.stderr, /fetch-depth: 0/);
  assert.match(cli.stderr, /git fetch origin/);
  assert.match(cli.stderr, /or pass a base the checkout contains/);
});

test("shallow clone with no default-branch ref: the head-fallback note tells the shallow story too, never the default-branch-build guess (second shape)", () => {
  const f = initShallowClone({ "src/a.ts": GOOD_ANNOTATION });
  // Strip every ref a DEFAULT_BRANCH_REFS probe could resolve — the clone's
  // remote-tracking refs AND its own local `main` (the probes include the
  // local names) — so the base falls back to HEAD: the second thin shape.
  git(f.root, "checkout", "--detach");
  git(f.root, "update-ref", "-d", "refs/remotes/origin/HEAD");
  git(f.root, "update-ref", "-d", "refs/remotes/origin/main");
  git(f.root, "branch", "-D", "main");
  fs.writeFileSync(path.join(f.root, "src/a.ts"), GOOD_ANNOTATION + "\n// uncommitted\n");

  const selection = selectFiles([], f.root, { changed: true });
  assert.equal(selection.base, git(f.root, "rev-parse", "HEAD").trim());
  assert.deepEqual(selection.files, ["src/a.ts"]);
  const note = selection.note ?? "";
  assert.match(note, /shallow \(depth-limited\) clone/);
  assert.match(note, /fell back to HEAD/);
  assert.match(note, /fetch-depth: 0/);
  assert.ok(!note.includes("default-branch build"));
});

test("shallow clone, the named remedy works: an explicit base the checkout contains selects normally and carries no note (AC1 remedy pin)", () => {
  const f = initShallowClone({ "src/a.ts": GOOD_ANNOTATION });
  fs.writeFileSync(path.join(f.root, "src/a.ts"), GOOD_ANNOTATION + "\n// uncommitted\n");
  const tip = git(f.root, "rev-parse", "HEAD").trim();

  const selection = selectFiles([], f.root, { changed: true, base: tip });
  assert.deepEqual(selection.files, ["src/a.ts"]);
  assert.equal(selection.note, null); // an in-history explicit base is not a thin base
});

test("full clone (AC3): thin-base notes and the diff-failure error keep their exact pre-shallow text", () => {
  // merge_base === HEAD, NOT shallow: the "default-branch build" note is exact.
  const f = initRepo({ "src/a.ts": GOOD_ANNOTATION });
  commitAll(f, "base"); // clean tree
  const selection = selectFiles([], f.root, { changed: true });
  assert.equal(
    selection.note,
    "the diff base is HEAD itself (this looks like a default-branch build), " +
      "so only uncommitted changes can be selected",
  );

  // head_fallback, NOT shallow: exact.
  const g = initRepo({ "src/a.ts": GOOD_ANNOTATION }, "feature");
  commitAll(g, "base");
  const fallback = selectFiles([], g.root, { changed: true });
  assert.equal(
    fallback.note,
    "no default-branch ref (origin/HEAD, origin/main, origin/master, main, master) could be found, " +
      "so the diff base fell back to HEAD; --changed can only select uncommitted changes here",
  );

  // A diff failure in a NON-shallow repo keeps the bare message, byte-identical.
  const absentSha = "0".repeat(40);
  let message = "";
  try {
    selectFiles([], g.root, { changed: true, base: absentSha });
  } catch (error) {
    message = (error as Error).message;
  }
  assert.equal(message, `--changed could not diff against "${absentSha}"`);
});

// --- SPGD-1188: the version identity ----------------------------------------
//
// The Ruby client answers `-v/--version` with ONE identity line, exit 0,
// before scanning (cli.rb, pinned in cli_spec.rb as "a version-only run
// scans nothing on its way to the exit"); the TS pair answered exit 2. The
// identity string is the SAME version() the User-Agent stamps (transport.ts),
// exported rather than re-read. The pins below mirror the Ruby triple: the
// line + exit 0 in every invocation position, a version-only run that
// discovers nothing, and a misuse arm that still refuses near-miss flags.
// The FORMAT is pinned (against the live package version, like the Ruby suite
// pins SpecGuard::VERSION) — never a literal.

const pkgVersion: string = (
  JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

test("SPGD-1188: the version prints one line and exits 0 in every invocation position", () => {
  const expected = `specguard-ts ${pkgVersion}\n`;
  for (const argv of [["--version"], ["-v"], ["lint", "--version"], ["lint", "-v"]]) {
    const out = capture();
    const err = capture();
    const exit = runCli(argv, out.stream, err.stream);
    assert.equal(exit, EXIT_OK, `specguard ${argv.join(" ")} must exit 0`);
    assert.equal(
      out.lines.join(""),
      expected,
      `specguard ${argv.join(" ")} must print exactly the one identity line on stdout`,
    );
    assert.equal(err.lines.join(""), "");
  }
});

test("SPGD-1188: a version-only run discovers nothing on its way to the exit", () => {
  // A repo holding a scannable annotated file, and a process.cwd stub that
  // throws: discovery's first act is cwd (the same stub the SPGD-1124
  // boundary test uses to reach lint()'s selection), so a version-only run
  // that still answers with the identity line and exit 0 proves it never
  // discovered — and never scanned the file sitting next to it.
  const f = makeRepo({ "guarded.ts": GOOD_ANNOTATION + "\n" });
  const out = capture();
  const err = capture();
  const originalCwd = process.cwd.bind(process);
  process.cwd = () => {
    throw new Error("a version-only run must not discover: cwd exploded");
  };
  try {
    const exit = runCli(["lint", "--version"], out.stream, err.stream);
    assert.equal(exit, EXIT_OK);
    assert.equal(out.lines.join(""), `specguard-ts ${pkgVersion}\n`);
    assert.equal(err.lines.join(""), "");
  } finally {
    process.cwd = originalCwd;
  }
});

test("SPGD-1188: near-miss flags are NOT swallowed by the version arm", () => {
  // The misuse arm keeps its exact vocabulary: subcommand position stays
  // "unknown command", lint position stays "invalid option", both exit 2 —
  // the version arm is exact-match only.
  const unknownOut = capture();
  const unknownErr = capture();
  assert.equal(runCli(["--versions"], unknownOut.stream, unknownErr.stream), EXIT_MISUSE);
  assert.match(unknownErr.lines.join(""), /unknown command: --versions/);
  assert.equal(unknownOut.lines.join(""), "");

  for (const flag of ["--versions", "--ver"]) {
    const o = capture();
    const e = capture();
    assert.equal(runCli(["lint", flag], o.stream, e.stream), EXIT_MISUSE);
    assert.match(e.lines.join(""), new RegExp(`invalid option: ${flag}`));
    assert.equal(o.lines.join(""), "");
  }
});

test("SPGD-1188: help describes -v, --version and keeps the usage line", () => {
  const out = capture();
  const err = capture();
  const exit = runCli(["lint", "--help"], out.stream, err.stream);
  assert.equal(exit, 0);
  const text = out.lines.join("");
  assert.match(text, /^Usage: specguard lint \[--json\] \[--changed\[=<base>\]\] \[files\.\.\.\]$/m);
  assert.match(text, /-v, --version/);
});

test("SPGD-1284: help's --changed block names the dependency/build directory fence and drops the false gitignore claim", () => {
  const out = capture();
  const err = capture();
  const exit = runCli(["lint", "--help"], out.stream, err.stream);
  assert.equal(exit, 0);
  const text = out.lines.join("");
  // SPGD-1273 fenced --changed with the fixed directory list on BOTH git
  // legs; .gitignore only fences the untracked leg, so the pre-1273 clause
  // "gitignored paths never are [checked]" is false — and this help block is
  // the one site carrying that claim that the shipped binary prints. The
  // false clause stays gone and the fence that actually holds is named.
  assert.doesNotMatch(text, /gitignored paths never are/);
  assert.match(text, /Either leg\n +skips the fixed dependency\/build directories/);
  assert.match(text, /node_modules, \.git, dist, \.test-build, coverage/);
  // The surviving .gitignore mention is scoped to the untracked leg only.
  assert.match(text, /\.gitignore keeps paths out of that untracked leg\n +only/);
  // The still-true untracked clause was not deleted wholesale.
  assert.match(text, /not been git-added is still checked/);
});

// ── SPGD-1550: the SEPARATED unreachable arm ────────────────────────────────
// A well-formed comment-form `@intent:` separated from its example by ONE
// intervening blank/ordinary-comment line is discarded at extraction (the
// one-line lookback claims only the line directly above the example) while
// the binary validates it clean. The pins assert the FAIL row / exit code /
// flagged lines — never the annotation count alone, which is already true
// (and green) on unfixed code.

const SEP_INTENT =
  '// @intent: { "behavior": "user can log in with valid credentials", "layer": "unit", "entity": "session", "action": "create" }';
const SEP_INTENT_2 =
  '// @intent: { "behavior": "user is rejected with a bad password", "layer": "unit", "entity": "session", "action": "reject" }';

function sepStub(file: string, lines: number[]): string {
  return stubBackend(
    lines.map((line) => ({ file, line, kind: null, ok: true, errors: [] })),
    lines.length,
  );
}

function sepRun(name: string, body: string[], annotationLines: number[]) {
  const file = `${name}.test.js`;
  const f = makeRepo({ [file]: body.join("\n") + "\n" });
  const report = inRepo(f, [file], sepStub(file, annotationLines));
  return {
    file,
    report,
    flagged: report.findings.filter((x) => x.kind === "unreachable").map((x) => x.line),
  };
}

test("SPGD-1550: an @intent separated from its test by one ordinary comment exits 1 with a FAIL row", () => {
  const { file, report, flagged } = sepRun(
    "comment-sep",
    [SEP_INTENT, "// an ordinary note about this test", 'test("separated by ordinary comment", () => {});'],
    [1],
  );
  assert.equal(report.exitCode, EXIT_MALFORMED);
  assert.ok(!report.ok);
  assert.deepEqual(flagged, [1]);
  const row = report.findings.find((x) => x.kind === "unreachable")!;
  assert.equal(row.file, file);
  assert.equal(row.ok, false);
  assert.equal(row.aboutFile, false);
  assert.ok(row.errors[0]?.includes("one-line lookback"));
  assert.match(renderHuman(report), /FAIL comment-sep\.test\.js:1 \(unreachable\)/);
  const json = JSON.parse(renderJson(report)) as {
    ok: boolean;
    findings: { line: number; kind: string; ok: boolean }[];
  };
  assert.equal(json.ok, false);
  assert.ok(json.findings.some((x) => x.line === 1 && x.kind === "unreachable" && x.ok === false));
  // Counting: the binary's count stands; the flagged line rides `malformed`.
  assert.equal(report.summary.annotations, 1);
  assert.equal(report.summary.malformed, 1);
});

test("SPGD-1550: an @intent separated from its test by one blank line exits 1 with the same verdict", () => {
  const { report, flagged } = sepRun(
    "blank-sep",
    [SEP_INTENT, "", 'test("separated by blank", () => {});'],
    [1],
  );
  assert.equal(report.exitCode, EXIT_MALFORMED);
  assert.deepEqual(flagged, [1]);
  assert.match(renderHuman(report), /FAIL blank-sep\.test\.js:1 \(unreachable\)/);
  assert.equal(report.summary.annotations, 1);
  assert.equal(report.summary.malformed, 1);
});

test("SPGD-1550: a >=2-line run + one interleave + example flags EVERY line of the run", () => {
  const { report, flagged } = sepRun(
    "run-sep",
    [SEP_INTENT, SEP_INTENT_2, "", 'test("run then blank", () => {});'],
    [1, 2],
  );
  assert.equal(report.exitCode, EXIT_MALFORMED);
  assert.deepEqual(flagged, [1, 2]);
  assert.equal(report.summary.annotations, 2);
  assert.equal(report.summary.malformed, 2);
});

test("SPGD-1550: an @intent directly above its test stays green — the arm never fires on the claimed shape", () => {
  const { report, flagged } = sepRun("direct", [SEP_INTENT, 'test("direct", () => {});'], [1]);
  assert.equal(report.exitCode, EXIT_OK);
  assert.deepEqual(flagged, []);
  assert.equal(report.summary.malformed, 0);
});

test("SPGD-1550: a stacked pair directly above its test gets exactly the stacked flag, not a doubled one", () => {
  const { report, flagged } = sepRun(
    "stacked-direct",
    [SEP_INTENT, SEP_INTENT_2, 'test("stacked", () => {});'],
    [1, 2],
  );
  assert.equal(report.exitCode, EXIT_MALFORMED);
  assert.deepEqual(flagged, [1]);
  assert.equal(report.summary.malformed, 1);
});

test("SPGD-1550: code interleaved between the @intent and its test is NOT flagged (out of scope)", () => {
  const { report, flagged } = sepRun(
    "code-between",
    [SEP_INTENT, "", "const x = 1;", 'test("after code", () => {});'],
    [1],
  );
  assert.equal(report.exitCode, EXIT_OK);
  assert.deepEqual(flagged, []);
  assert.equal(report.summary.malformed, 0);
});

test("SPGD-1550: a describe( after the interleave is NOT flagged — the SPGD-1522 deferral stays a deferral", () => {
  for (const between of ["", "// an ordinary note"]) {
    const { report, flagged } = sepRun(
      "describe-after",
      [SEP_INTENT, between, 'describe("group", () => {', '  test("inner", () => {});', "});"],
      [1],
    );
    assert.equal(report.exitCode, EXIT_OK, `interleave ${JSON.stringify(between)}`);
    assert.deepEqual(flagged, []);
  }
});

test("SPGD-1550: two blank lines between the @intent and its test is NOT flagged in this slice (window is exactly one line)", () => {
  const { report, flagged } = sepRun(
    "two-blanks",
    [SEP_INTENT, "", "", 'test("two blanks", () => {});'],
    [1],
  );
  assert.equal(report.exitCode, EXIT_OK);
  assert.deepEqual(flagged, []);
  assert.equal(report.summary.malformed, 0);
});

test("SPGD-1550: a run followed by a blank/const with NO example after (SPGD-1521 AC4 shape) stays unflagged", () => {
  const { report, flagged } = sepRun(
    "no-example",
    [SEP_INTENT, SEP_INTENT_2, "", "const x = 1;"],
    [1, 2],
  );
  assert.equal(report.exitCode, EXIT_OK);
  assert.deepEqual(flagged, []);
});

test("SPGD-1550: an interleave comment that itself carries an @intent token is a run member, not an interleave", () => {
  // Blank-then-example after a 2-run is the flagged shape (pinned above); an
  // @intent-bearing "comment" joins the run instead, so this is the stacked
  // arm's verdict — one stacked flag on line 1, nothing from the separated arm.
  const { flagged } = sepRun(
    "intent-comment",
    [SEP_INTENT, SEP_INTENT_2, 'test("stacked", () => {});'],
    [1, 2],
  );
  assert.deepEqual(flagged, [1]);
});

test("SPGD-1550: a single CODE line between the @intent and its test is NOT flagged — only blank/ordinary-comment interleaves are", () => {
  for (const between of ["const x = 1;", "  helper();", "/* block */"]) {
    const { report, flagged } = sepRun(
      "code-single",
      [SEP_INTENT, between, 'test("after one code line", () => {});'],
      [1],
    );
    assert.equal(report.exitCode, EXIT_OK, `interleave ${JSON.stringify(between)}`);
    assert.deepEqual(flagged, [], `interleave ${JSON.stringify(between)}`);
    assert.equal(report.summary.malformed, 0);
  }
});

// ── SPGD-1556: the OWN-LINE-SHADOW unreachable arm ──────────────────────────
// A comment-form `@intent:` directly above an example that ALSO carries its
// own trailing `@intent: {…}` loses to own-line-first extraction (annotate.ts
// ARM 1 before ARM 2), so no test can ever claim it. Only the run's LAST line
// is flagged; the stacked arm owns the rest of a >=2 run.

const SHADOW_TRAIL =
  '// @intent: { "behavior": "trailing annotation owns the test", "layer": "unit", "entity": "session", "action": "create" }';
const SHADOW_ONE_LINER = `test("x", () => {}); ${SHADOW_TRAIL}`;

test("SPGD-1556: a comment @intent directly above a trailing-annotated one-liner exits 1 with ONE finding on the comment line", () => {
  const { file, report, flagged } = sepRun("shadow-one", [SEP_INTENT, SHADOW_ONE_LINER], [1, 2]);
  assert.equal(report.exitCode, EXIT_MALFORMED);
  assert.ok(!report.ok);
  assert.deepEqual(flagged, [1]);
  const row = report.findings.find((x) => x.kind === "unreachable")!;
  assert.equal(row.file, file);
  assert.equal(row.ok, false);
  assert.equal(row.aboutFile, false);
  assert.equal(row.intent, null);
  assert.ok(row.errors[0]?.includes("own-line-first"));
  assert.match(renderHuman(report), /FAIL shadow-one\.test\.js:1 \(unreachable\)/);
  assert.doesNotMatch(renderHuman(report), /FAIL shadow-one\.test\.js:2 \(unreachable\)/);
  const json = JSON.parse(renderJson(report)) as {
    ok: boolean;
    findings: { line: number; kind: string; ok: boolean }[];
  };
  assert.equal(json.ok, false);
  assert.ok(json.findings.some((x) => x.line === 1 && x.kind === "unreachable" && x.ok === false));
  assert.equal(report.summary.annotations, 2);
  assert.equal(report.summary.malformed, 1);
});

test("SPGD-1556: a stacked pair above a trailing-annotated one-liner flags BOTH run lines, none twice", () => {
  const { report, flagged } = sepRun(
    "shadow-stacked",
    [SEP_INTENT, SEP_INTENT_2, SHADOW_ONE_LINER],
    [1, 2, 3],
  );
  assert.equal(report.exitCode, EXIT_MALFORMED);
  assert.deepEqual(flagged, [1, 2]);
  assert.equal(report.summary.annotations, 3);
  assert.equal(report.summary.malformed, 2);
});

test("SPGD-1556: a comment above a test with NO trailing annotation stays green", () => {
  const { report, flagged } = sepRun("shadow-none", [SEP_INTENT, 'test("x", () => {});'], [1]);
  assert.equal(report.exitCode, EXIT_OK);
  assert.deepEqual(flagged, []);
  assert.equal(report.summary.malformed, 0);
});

test("SPGD-1556: a one-liner whose trailing text is a plain comment (no @intent: {) stays green", () => {
  const { report, flagged } = sepRun(
    "shadow-plain-trailer",
    [SEP_INTENT, 'test("x", () => {}); // just a note'],
    [1],
  );
  assert.equal(report.exitCode, EXIT_OK);
  assert.deepEqual(flagged, []);
});

test("SPGD-1556: separated shapes are not flagged by the shadow arm (example must be on the line right after the run)", () => {
  for (const between of ["", "// an ordinary note"]) {
    const { flagged } = sepRun("shadow-separated", [SEP_INTENT, between, SHADOW_ONE_LINER], [1, 3]);
    // The separated arm (SPGD-1550) owns this shape: exactly line 1, once.
    assert.deepEqual(flagged, [1], `interleave ${JSON.stringify(between)}`);
  }
  const text = [SEP_INTENT, "", SHADOW_ONE_LINER, ""].join("\n");
  assert.deepEqual(ownLineShadowFindingsInText(text, "f.test.js"), []);
  const text2 = [SEP_INTENT, "const x = 1;", SHADOW_ONE_LINER, ""].join("\n");
  assert.deepEqual(ownLineShadowFindingsInText(text2, "f.test.js"), []);
});

test("SPGD-1556: prose guard — an @intent: without { in the example's description does not trigger", () => {
  const { report, flagged } = sepRun(
    "shadow-prose",
    [SEP_INTENT, 'test("mentions @intent: in prose", () => {});'],
    [1],
  );
  assert.equal(report.exitCode, EXIT_OK);
  assert.deepEqual(flagged, []);
});

test("SPGD-1556: linting annotated-same-line.test.js's text flags exactly line 13 (fixture itself untouched)", () => {
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "annotated-same-line.test.js");
  const text = fs.readFileSync(fixture, "utf8");
  const found = ownLineShadowFindingsInText(text, "annotated-same-line.test.js");
  assert.deepEqual(found.map((x) => x.line), [13]);
  // ...and through the full lint pipeline on a copy.
  const { report, flagged } = sepRun("shadow-fixture", text.replace(/\n$/, "").split("\n"), [11, 13, 14]);
  assert.deepEqual(flagged, [13]);
  assert.equal(report.exitCode, EXIT_MALFORMED);
});

// --- SPGD-1539: the lint-side registers are POSIX-separated ----------------
//
// The repo builds a repo-relative path register in SIX places. The four
// telemetry-side ones (the three collectors' `relativize`, annotate.ts's
// `normalizeRepoPath`) fold `path.sep` → `/`; the two LINT-side ones did not
// — `lint.ts`'s walk-arm rebuild and `discover.ts`'s `--changed` push. On
// win32 `specguard lint` therefore named `src\deep\a.test.ts` for the file
// every collector and every annotate warning names `src/deep/a.test.ts`,
// re-opening the one-file-two-spellings divergence SPGD-1011 → 1026 → 1533
// → 1537 closed. The contract is stated in the repo's own words at
// src/node-test/annotate.ts:79: "repo-relative, posix separators".
//
// WHY THESE PINS ARE NOT `{ skip: process.platform === "win32" ? … }`, the
// idiom test/annotate.test.ts:682/:786 uses. That idiom is correct THERE and
// would be inert HERE, and the difference is the fixture's premise. Those
// pins feed a BACKSLASH LITERAL to `normalizeRepoPath`; on POSIX a backslash
// is a legal filename character that node:path leaves verbatim, so the
// fixture's premise is false off win32 and a skip is the honest answer. The
// premise here is not a literal — it is `path.sep`/`path.relative` SEMANTICS,
// and `node:path` ships both platforms' implementations on every platform
// (`path.win32`). Both production sites reach the separator through the
// mutable `path` namespace (`import path from "node:path"`), so injecting
// `path.win32`'s `sep`/`relative` for the duration of one example gives
// GENUINE win32 separator semantics on a Linux runner.
//
// That matters for more than tidiness: a platform-gated pin is a permanent
// skip on this repo's CI (.github/workflows/ci.yml is `runs-on:
// ubuntu-latest`, matrix over Node only — never the OS), so it could never
// go red for the revert attributions these pins exist to provide. Injected,
// each one is a real red/green instrument on every platform. Only `sep` and
// `relative` are swapped — deliberately NOT `join`/`isAbsolute`/`resolve`,
// which the same code paths use to touch the REAL filesystem: a win32 `join`
// would mint `\tmp\…` and the fixture files would stop existing, turning a
// register assertion into an unreadable-file assertion.
function withWin32Separators<T>(fn: () => T): T {
  const savedSep = path.sep;
  const savedRelative = path.relative;
  (path as unknown as { sep: string }).sep = path.win32.sep;
  (path as unknown as { relative: typeof path.relative }).relative = path.win32.relative;
  try {
    return fn();
  } finally {
    (path as unknown as { sep: string }).sep = savedSep;
    (path as unknown as { relative: typeof path.relative }).relative = savedRelative;
  }
}

test("SPGD-1539 (AC1): the walk register is posix-separated under win32 separator semantics", () => {
  // Nested fixture, mandatory: a root-level file has no directory component,
  // so a register assertion and a basename assertion would have identical
  // truth values and the pin could not discriminate (the SPGD-1537
  // measurement). `src/deep/a.test.ts` can only be satisfied by genuine
  // relativization AND a genuine separator fold.
  const f = makeRepo({ "src/deep/a.test.ts": GOOD_ANNOTATION });
  // The echo stub mirrors what it was HANDED — each --source pattern becomes
  // a finding naming that pattern verbatim — so the finding below reads the
  // register lint actually built, not a stub-fabricated name (the
  // SPGD-1533 discipline at test/lint.test.ts:330-334).
  const binary = echoingBackend(1);
  const report = withWin32Separators(() => inRepo(f, [], binary)); // bare walk
  assert.equal(report.exitCode, EXIT_MALFORMED);
  // Literal, un-normalized: exactly the string `normalizeRepoPath` yields for
  // the same input, and the same string every collector's `relativize`
  // yields. Un-patched `path.relative` here would make the pin blind to the
  // separator, which is the whole claim.
  assert.deepEqual(report.findings.map((x) => x.file), ["src/deep/a.test.ts"]);
  const human = renderHuman(report);
  assert.match(human, /FAIL src\/deep\/a\.test\.ts:1 \(schema\)/);
  assert.ok(!human.includes("\\"), `backslash separator leaked into the report: ${human}`);
  // The register is a JOIN KEY inside lint, not only display: `--json` copies
  // finding.file verbatim, so a win32 consumer must see the same key every
  // telemetry surface uses.
  const json = JSON.parse(renderJson(report)) as { findings: { file: string }[] };
  assert.deepEqual(json.findings.map((x) => x.file), ["src/deep/a.test.ts"]);
});

test("SPGD-1539 (AC2): the --changed register is posix-separated under win32 separator semantics", () => {
  const f = initRepo({ "src/keep.ts": GOOD_ANNOTATION });
  commitAll(f, "base");
  git(f.root, "checkout", "-b", "feature");
  fs.mkdirSync(path.join(f.root, "src/deep"), { recursive: true });
  fs.writeFileSync(path.join(f.root, "src/deep/a.test.ts"), GOOD_ANNOTATION);
  commitAll(f, "feature change");

  // Unit-level on the pushed value at discover.ts:363 — deliberately not via
  // lint(), so this pin names the producer and not a downstream renderer.
  const selection = withWin32Separators(() => selectFiles([], f.root, { changed: true }));
  assert.equal(selection.mode, "changed");
  assert.deepEqual(selection.files, ["src/deep/a.test.ts"]); // nested, literal
  assert.ok(
    !selection.files.some((file) => file.includes("\\")),
    `backslash separator leaked into the register: ${JSON.stringify(selection.files)}`,
  );
});

test("SPGD-1539 (AC3a): the out-of-root guard still fires — the fold is on the PUSHED value, not the shared local", () => {
  // discover.ts:341's `relative` local feeds THREE consumers and only the
  // push may see a folded value: the `outside` guard tests `..${path.sep}`,
  // so a folded local yields `../…` on win32, which that guard does not
  // match — admitting an out-of-root file into the selection instead of
  // counting it in `outsideRoot`. This pin is that regression's only
  // defence; it is invisible on unpatched POSIX.
  const f = initRepo({
    "packages/app/src/deep/a.test.ts": GOOD_ANNOTATION,
    "packages/other/src/deep/out.test.ts": GOOD_ANNOTATION,
  });
  commitAll(f, "base");
  git(f.root, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(f.root, "packages/app/src/deep/a.test.ts"), GOOD_ANNOTATION + "\n// touched\n");
  fs.writeFileSync(path.join(f.root, "packages/other/src/deep/out.test.ts"), GOOD_ANNOTATION + "\n// touched\n");
  commitAll(f, "feature change");

  const selection = withWin32Separators(() =>
    selectFiles([], path.join(f.root, "packages/app"), { changed: true }),
  );
  assert.equal(selection.stats?.outsideRoot, 1); // counted, not selected
  assert.deepEqual(selection.files, ["src/deep/a.test.ts"]);
  assert.ok(
    !selection.files.some((file) => file.includes("..")),
    `an out-of-root escape entered the register: ${JSON.stringify(selection.files)}`,
  );
});

test("SPGD-1539 (AC3b): the SKIPPED_DIRECTORIES fence still fires — the fold is on the PUSHED value, not the shared local", () => {
  // `skippedDirectory` splits on `path.sep`, so a folded local yields ZERO
  // segments on win32 and the fence is dead: every vendored/built file under
  // node_modules, .git, dist, .test-build or coverage would be selected.
  // Nested under the fenced segment, so the discrimination is real.
  const f = initRepo({ "src/keep.ts": GOOD_ANNOTATION });
  commitAll(f, "base");
  git(f.root, "checkout", "-b", "feature");
  for (const rel of ["src/deep/a.test.ts", "dist/deep/built.test.ts"]) {
    fs.mkdirSync(path.dirname(path.join(f.root, rel)), { recursive: true });
    fs.writeFileSync(path.join(f.root, rel), GOOD_ANNOTATION);
  }
  commitAll(f, "feature change");

  const selection = withWin32Separators(() => selectFiles([], f.root, { changed: true }));
  assert.equal(selection.skipped, 1); // counted and disclosed, not selected
  assert.deepEqual(selection.files, ["src/deep/a.test.ts"]);
  assert.ok(
    !selection.files.some((file) => file.startsWith("dist/") || file.startsWith("dist\\")),
    `the SKIPPED_DIRECTORIES fence let a built file through: ${JSON.stringify(selection.files)}`,
  );
});
