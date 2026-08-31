import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { run as runCli } from "../src/cli.js";
import { annotateRows } from "../src/node-test/annotate.js";
import { renderJson } from "../src/lint/report.js";
import { lint } from "../src/lint/lint.js";
import { VALIDATE_INTENT_ENV_VAR } from "../src/core/validator.js";
import type { SpecRow } from "../src/core/types.js";

/**
 * The A/B against the REAL validate-intent binary — the integration
 * methodology's ground truth. Every stub elsewhere in test/ encodes the
 * binary's documented shape; this test builds the actual binary from the
 * sibling open-test-intent checkout and runs BOTH consumers over it, so a
 * stub skew (the SPGD-914 defect: stubs emitted `kind: "schema"` on passing
 * findings while the real binary emits `kind: null`, and the parse guard
 * refused the real shape — a vacuous green) can never re-appear undetected.
 *
 * SELF-SKIPPING, both gates, because `npm test` must stay green with neither:
 *   * no `go` on PATH — no toolchain, no build;
 *   * no /workspace/open-test-intent checkout — nothing to build.
 * A skip is VISIBLE in node:test output, never a silent pass (the vacuous-
 * green rule: "could not check" must read as skipped, not as checked-and-
 * clean). With both present the test runs for real.
 */
const INTENT_CHECKOUT = "/workspace/open-test-intent";

const goProbe = spawnSync("go", ["version"], { stdio: "ignore", timeout: 30_000 });
const checkoutPresent = fs.existsSync(path.join(INTENT_CHECKOUT, "go.mod"));
const skipReason =
  goProbe.error !== undefined || goProbe.status !== 0
    ? "no Go toolchain on PATH — real-binary A/B skipped (npm test never requires one)"
    : !checkoutPresent
      ? `no open-test-intent checkout at ${INTENT_CHECKOUT} — real-binary A/B skipped`
      : false;

/**
 * Build the REAL binary from the checkout into a FRESH temp dir — never trust
 * a pre-existing /tmp validator stub (the SPGD-906 trap: a stale stub in /tmp
 * is whatever shape its author sketched, not the binary's).
 */
function buildRealBinary(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specguard-real-validator-"));
  const target = path.join(dir, "validate-intent");
  const build = spawnSync("go", ["build", "-o", target, "./cmd/validate-intent"], {
    cwd: INTENT_CHECKOUT,
    env: { ...process.env, CGO_ENABLED: "0" },
    timeout: 240_000,
    encoding: "utf8",
  });
  if (build.error !== undefined || build.status !== 0 || !fs.existsSync(target)) {
    throw new Error(
      `building the real validate-intent from ${INTENT_CHECKOUT} failed ` +
        `(status ${build.status}): ${build.stderr ?? String(build.error)}`,
    );
  }
  return target;
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

/**
 * A temp repo whose every annotation is valid, laid out so the annotation
 * COMMENT lines are known constants (comment on line 1, test on line 2;
 * comment on line 4, test on line 5) — the coordinate discipline the annotate
 * half matches rows against.
 */
function makeAnnotatedRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "specguard-ab-repo-"));
  fs.writeFileSync(
    path.join(root, "a.test.js"),
    [
      `// @intent: ${JSON.stringify(INTENT_APPLY)}`,
      'test("applies a valid promo code", () => {});',
      "",
      `// @intent: ${JSON.stringify(INTENT_REJECT)}`,
      'test("rejects an expired promo code", () => {});',
      "",
    ].join("\n"),
  );
  return root;
}

function row(line: number, name: string): SpecRow {
  return {
    file_path: "a.test.js",
    line_number: line,
    status: "unannotated",
    intent: null,
    name,
    duration: null,
    id: `a.test.js:${line}`,
    outcome: "passed",
  };
}

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

test(
  "A/B against the REAL validate-intent binary: `specguard lint` exits 0 and the annotate path flips rows",
  { skip: skipReason },
  (t) => {
    const binary = buildRealBinary();
    const repo = makeAnnotatedRepo();
    t.after(() => {
      fs.rmSync(path.dirname(binary), { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    });

    // --- Half 1: the lint command, through the CLI entry point itself, with
    // the override in the REAL environment (the CLI reads process.env).
    // Before the kind:null fix this exact run was EXIT 2 ("emitted a finding
    // ... with no `kind`") — exit 0 was unreachable with a real binary the
    // moment an annotation was valid.
    const out = capture();
    const err = capture();
    const previousCwd = process.cwd();
    const previousOverride = process.env[VALIDATE_INTENT_ENV_VAR];
    process.env[VALIDATE_INTENT_ENV_VAR] = binary;
    process.chdir(repo);
    try {
      const exitCode = runCli(["lint"], out.stream, err.stream);
      assert.equal(exitCode, 0, `stderr: ${err.lines.join("")}`);
      assert.match(out.lines.join(""), /2 annotations/);
      assert.doesNotMatch(out.lines.join(""), /FAIL/);

      // The same run's report document, same cwd: N annotations, 0 malformed,
      // and every finding carries the binary's REAL passing shape — kind null
      // — through to the rendered JSON.
      const report = lint([], { env: { [VALIDATE_INTENT_ENV_VAR]: binary } });
      assert.equal(report.exitCode, 0);
      assert.equal(report.summary.annotations, 2);
      assert.equal(report.summary.malformed, 0);
      assert.equal(report.findings.length, 2);
      assert.ok(
        report.findings.every((f) => f.ok && f.kind === null),
        "every passing finding from the real binary carries kind: null",
      );
      const json = JSON.parse(renderJson(report)) as {
        findings: { kind: string | null; ok: boolean }[];
      };
      assert.ok(json.findings.every((f) => f.ok && f.kind === null));
      assert.ok(
        report.findings.some((f) => f.intent?.["behavior"] === INTENT_APPLY.behavior),
        "the validator-ratified intent rides the findings verbatim",
      );
    } finally {
      process.chdir(previousCwd);
      if (previousOverride === undefined) delete process.env[VALIDATE_INTENT_ENV_VAR];
      else process.env[VALIDATE_INTENT_ENV_VAR] = previousOverride;
    }

    // --- Half 2: the reporter's annotate path, the other consumer of the
    // same parse guard. Rows keyed at the test() lines (2 and 5) must flip to
    // annotated with the validator-ratified intent VERBATIM.
    const warnings: string[] = [];
    const annotated = annotateRows(
      [row(2, "applies a valid promo code"), row(5, "rejects an expired promo code")],
      {
        repoRoot: repo,
        env: { [VALIDATE_INTENT_ENV_VAR]: binary },
        warn: (m) => warnings.push(m),
      },
    );
    assert.deepEqual(warnings, []);
    assert.equal(annotated.annotated, 2);
    assert.ok(!annotated.degraded);
    assert.equal(annotated.rows[0]!.status, "annotated");
    assert.deepEqual(annotated.rows[0]!.intent, INTENT_APPLY);
    assert.equal(annotated.rows[1]!.status, "annotated");
    assert.deepEqual(annotated.rows[1]!.intent, INTENT_REJECT);
  },
);
