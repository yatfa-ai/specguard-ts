import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { lint, EXIT_OK, EXIT_MALFORMED, EXIT_MISUSE } from "../src/lint/lint.js";
import { renderJson, renderHuman } from "../src/lint/report.js";
import { selectFiles, scanTokens, escapeGlob } from "../src/lint/index.js";
import { SCHEMA_CONTRACT_DIGEST, VALIDATE_INTENT_ENV_VAR } from "../src/core/validator.js";

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
    [{ file: "a.test.ts", line: 1, kind: "schema", ok: true, errors: [] }],
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
    [{ file: "a.test.ts", line: 1, kind: "schema", ok: true, errors: [] }],
    5, // declares 5, emits 1 — the truncation guard
  );
  const report = inRepo(f, [], binary);
  assert.equal(report.exitCode, EXIT_MISUSE);
  assert.match(report.stderr.join("\n"), /reported 5 annotation/);
});
