import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const { join, dirname } = path;

import {
  SpecguardJestReporter,
  type JestReporterOptions,
} from "../src/jest/reporter.js";
import type { JestAssertionResult, JestSuiteResult, JestRunResult } from "../src/jest/collector.js";
import type { RunnerEnv } from "../src/core/env.js";
import type { Envelope } from "../src/core/types.js";
import { SCHEMA_CONTRACT_DIGEST, VALIDATE_INTENT_ENV_VAR } from "../src/core/validator.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function env(overrides: Partial<RunnerEnv> = {}): RunnerEnv {
  return {
    commitSha: "abc123",
    branch: "main",
    ciRunId: "17",
    shardId: "0",
    endpoint: "https://specguard.example.com",
    apiKey: "sgk_test",
    timeoutMs: 1000,
    outputPath: "log/test_results.jsonl",
    localOutputPath: "log/test_results.local.jsonl",
    ...overrides,
  };
}

function jestAssertion(title: string, line: number): JestAssertionResult {
  return {
    title,
    ancestorTitles: [],
    fullName: title,
    location: { line, column: 1 },
    status: "passed",
    duration: 250,
  };
}

function resultsOf(
  assertions: JestAssertionResult[],
  testFilePath = join(pkgRoot, "fixtures", "jest", "mixed.test.js"),
): JestRunResult {
  const suite: JestSuiteResult = { testFilePath, testResults: assertions };
  return { testResults: [suite] };
}

interface Seen {
  url: string;
  body: Envelope;
}

/**
 * Run one reporter over `results` with an intercepting transport. The
 * reporter is constructed the way Jest itself constructs it —
 * `(globalConfig, options, docs)` (measured on Jest 30) — so the unit
 * tests exercise the same two-argument options path the runner uses.
 */
async function runReporter(
  results: JestRunResult,
  options: Partial<JestReporterOptions> = {},
): Promise<{ seen: Seen[]; sink: string[]; stderr: string[] }> {
  const seen: Seen[] = [];
  const sink: string[] = [];
  const stderr: string[] = [];
  const origWrite = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const reporter = new SpecguardJestReporter({}, {
      env: env(),
      repoRoot: pkgRoot,
      transport: {
        fetchImpl: (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
          seen.push({ url: String(url), body: JSON.parse(String(init?.body)) as Envelope });
          return new Response("{}", { status: 202 });
        }) as unknown as typeof fetch,
        appendFileImpl: async (_p: string, data: string) => {
          sink.push(data);
        },
      },
      ...options,
    }, { startRun: undefined, firstRun: true, previousSuccess: undefined });
    await reporter.onRunComplete(new Map(), results);
    return { seen, sink, stderr };
  } finally {
    process.stderr.write = origWrite;
  }
}

test("the reporter collects rows and POSTs one envelope through the transport", async () => {
  const { seen } = await runReporter(resultsOf([
    { ...jestAssertion("outer", 5), ancestorTitles: ["outer"] },
    { ...jestAssertion("child failing", 9), status: "failed" },
  ]));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "https://specguard.example.com/api/v1/ingest");
  const body = seen[0]!.body;
  assert.equal(body.commit_sha, "abc123");
  assert.equal(body.specs.length, 2);
  assert.equal(body.specs[0]!.file_path, "fixtures/jest/mixed.test.js");
  assert.equal(body.specs[0]!.duration, 0.25); // 250 ms -> seconds
  assert.equal(typeof body.duration_seconds, "number");
});

test("a run that reported zero tests POSTs nothing and writes nothing", async () => {
  const { seen, sink } = await runReporter(resultsOf([]));
  assert.equal(seen.length, 0);
  assert.equal(sink.length, 0);
});

test("dropped rows (no location) warn on stderr naming testLocationInResults", async () => {
  const { stderr, seen } = await runReporter(resultsOf([{ ...jestAssertion("no-loc", 1), location: null }]));
  assert.equal(seen.length, 0); // every row dropped -> zero rows -> no POST
  assert.ok(stderr.some((line) => line.includes("dropped 1") && line.includes("testLocationInResults")), stderr.join(""));
});

test("no commit sha: one stderr line, no POST, no crash", async () => {
  const { seen, stderr } = await runReporter(resultsOf([jestAssertion("a", 1)]), {
    env: env({ commitSha: null }),
  });
  assert.equal(seen.length, 0);
  assert.ok(stderr.some((l) => l.includes("no commit sha")), stderr.join(""));
});

test("the annotation pass runs through the unchanged shared path", async (t) => {
  // A temp "repo" with one annotated source, and a stub backend that ratifies
  // the annotation at its COMMENT line — the same fixture discipline as
  // test/annotate.test.ts, proving the Jest reporter feeds annotateRows.
  const repo = fs.mkdtempSync(join(os.tmpdir(), "specguard-jest-reporter-"));
  const source = join(repo, "annotated.test.js");
  const lines = [
    '// @intent: {"entity":"Cart","action":"apply promo code","behavior":"applies the discount","layer":"unit"}',
    'it("applies", () => {});',
    "",
  ];
  fs.writeFileSync(source, lines.join("\n") + "\n");
  const doc = JSON.stringify({
    mode: "source",
    findings: [
      {
        file: source,
        line: 1,
        kind: "schema",
        ok: true,
        errors: [],
        intent: { entity: "Cart", action: "apply promo code", behavior: "applies the discount", layer: "unit" },
      },
    ],
    summary: { annotations: 1 },
  });
  const bin = join(repo, "validate-intent");
  fs.writeFileSync(
    bin,
    [
      "#!/bin/sh",
      "case \"$1\" in",
      `  --version) printf '%s\\n' 'validate-intent stub (jest-reporter) schema sha256:${SCHEMA_CONTRACT_DIGEST}'; exit 0 ;;`,
      `  --schema-source) printf '%s\\n' 'schema <embedded schema> sha256:${SCHEMA_CONTRACT_DIGEST}'; exit 0 ;;`,
      "esac",
      "if [ \"$1\" = \"--source\" ]; then",
      `  printf '%s\\n' '${doc.replace(/'/g, `'\\''`)}'`,
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n") + "\n",
    { mode: 0o755 },
  );

  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  const { seen } = await runReporter(resultsOf([jestAssertion("applies", 2)], source), {
    repoRoot: repo,
    validator: { env: { [VALIDATE_INTENT_ENV_VAR]: bin } },
  });
  assert.equal(seen.length, 1);
  const row = seen[0]!.body.specs[0]!;
  assert.equal(row.name, "applies");
  assert.equal(row.status, "annotated");
  assert.deepEqual(row.intent, {
    entity: "Cart",
    action: "apply promo code",
    behavior: "applies the discount",
    layer: "unit",
  });
});

test("never-fail: a poison results object cannot throw out of onRunComplete", async () => {
  const origWrite = process.stderr.write;
  const stderr: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const reporter = new SpecguardJestReporter({}, { env: env(), repoRoot: pkgRoot } as JestReporterOptions);
    // Hostile at two depths: the aggregated testResults getter throws on
    // read (contained by the collector's suite-list guard), and a suite
    // survives with an assertion whose `location` getter throws — that one
    // is counted as a dropped row, so the reporter's one loud warning (the
    // "unaffected" line) still fires.
    const throwingAggregated = {
      get testResults() {
        throw new Error("boom");
      },
    };
    await reporter.onRunComplete(new Map(), throwingAggregated);
    const throwingAssertion = {
      get location() {
        throw new Error("boom");
      },
    };
    await reporter.onRunComplete(new Map(), {
      testResults: [{ testFilePath: "/repo/x.test.js", testResults: [throwingAssertion] }],
    });
    assert.ok(stderr.some((l) => l.includes("unaffected")), stderr.join(""));
  } finally {
    process.stderr.write = origWrite;
  }
});

test("the constructor never throws: junk arguments degrade to defaults", () => {
  // Jest instantiates with (globalConfig, options, docs); hostile or absent
  // arguments in either position must still produce a usable reporter.
  const noArgs = new (SpecguardJestReporter as unknown as new () => SpecguardJestReporter)();
  assert.ok(noArgs instanceof SpecguardJestReporter);
  const nullOptions = new (SpecguardJestReporter as unknown as new (g: unknown, o?: unknown) => SpecguardJestReporter)({}, null);
  assert.ok(nullOptions instanceof SpecguardJestReporter);
  const stringOptions = new (SpecguardJestReporter as unknown as new (g: unknown, o?: unknown) => SpecguardJestReporter)({}, "junk");
  assert.ok(stringOptions instanceof SpecguardJestReporter);
  // one-argument construction (an older runner's shape) must not throw either
  const oneArg = new (SpecguardJestReporter as unknown as new (g?: unknown) => SpecguardJestReporter)({});
  assert.ok(oneArg instanceof SpecguardJestReporter);
});

test("onRunStart resets the run clock: each watch rerun measures its own duration", async () => {
  const seen: Seen[] = [];
  const reporter = new SpecguardJestReporter({}, {
    env: env(),
    repoRoot: pkgRoot,
    transport: {
      fetchImpl: (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        seen.push({ url: String(url), body: JSON.parse(String(init?.body)) as Envelope });
        return new Response("{}", { status: 202 });
      }) as unknown as typeof fetch,
    },
  });
  // Fake the first run starting long ago, then a watch rerun "just now".
  (reporter as unknown as { startedAtMs: number }).startedAtMs = Date.now() - 60_000;
  reporter.onRunStart(new Map());
  await reporter.onRunComplete(new Map(), resultsOf([jestAssertion("a", 1)]));
  assert.equal(seen.length, 1);
  const duration = seen[0]!.body.duration_seconds;
  assert.ok(duration !== null && duration < 10, `duration ${String(duration)} must be measured from onRunStart, not construction`);
});
