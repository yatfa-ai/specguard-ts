import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { lint, EXIT_OK, EXIT_MALFORMED, EXIT_MISUSE } from "../src/lint/lint.js";
import { renderJson, renderHuman } from "../src/lint/report.js";
import { selectFiles, scanTokens, escapeGlob, SCAN_MAX_BYTES } from "../src/lint/index.js";
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

function inRepo(fixture: Fixture, argv: string[], bin?: string) {
  const previous = process.cwd();
  process.chdir(fixture.root);
  try {
    return lint(argv, { env: envWith(bin) });
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
 * to make that deterministic.
 */
function runCliInRepo(
  fixture: Fixture,
  argv: string[],
): { exit: number; stdout: string; stderr: string } {
  const out = capture();
  const err = capture();
  const previousCwd = process.cwd();
  const previousOverride = process.env[VALIDATE_INTENT_ENV_VAR];
  delete process.env[VALIDATE_INTENT_ENV_VAR];
  process.chdir(fixture.root);
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
