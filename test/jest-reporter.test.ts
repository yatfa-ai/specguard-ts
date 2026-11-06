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
    repositoryId: null,
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
  globalConfig: unknown = {},
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
    const reporter = new SpecguardJestReporter(globalConfig, {
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

test("three same-titled tests in one file ship three distinct ids and the failing one keeps its outcome", async () => {
  const { seen } = await runReporter(resultsOf([
    jestAssertion("adds", 5),
    { ...jestAssertion("adds", 7), status: "failed" },
    jestAssertion("adds", 9),
  ]));
  assert.equal(seen.length, 1);
  const specs = seen[0]!.body.specs;
  assert.equal(specs.length, 3);
  assert.equal(new Set(specs.map((s) => s.id)).size, 3);
  assert.deepEqual(specs.map((s) => s.outcome), ["passed", "failed", "passed"]);
  assert.ok(specs.every((s) => s.name === "adds"));
});

test("a run that reported zero tests POSTs nothing and writes nothing", async () => {
  const { seen, sink } = await runReporter(resultsOf([]));
  assert.equal(seen.length, 0);
  assert.equal(sink.length, 0);
});

test("rows with no location ship with source-derived lines and ONE notice naming testLocationInResults", async () => {
  const { stderr, seen } = await runReporter(
    resultsOf([
      { ...jestAssertion("child ok", 1), location: null },
      { ...jestAssertion("child failing", 1), location: null, status: "failed" },
      { ...jestAssertion("not in the source", 1), location: null },
    ]),
    {},
    { testLocationInResults: false },
  );
  assert.equal(seen.length, 1, "rows ship although Jest reported no location");
  const lines = Object.fromEntries(seen[0]!.body.specs.map((s) => [s.name, s.line_number]));
  const source = fs.readFileSync(join(pkgRoot, "fixtures", "jest", "mixed.test.js"), "utf8").split("\n");
  assert.equal(lines["child ok"], source.findIndex((l) => l.startsWith('  it("child ok"')) + 1);
  assert.equal(lines["child failing"], source.findIndex((l) => l.startsWith('  it("child failing"')) + 1);
  assert.equal(lines["not in the source"], 1);
  const notices = stderr.filter((l) => l.includes("derived from the test source"));
  assert.equal(notices.length, 1, stderr.join(""));
  assert.ok(notices[0]!.includes("`testLocationInResults` is off"), notices[0]);
  assert.ok(notices[0]!.includes("1 could not be matched"), notices[0]);
  assert.ok(!stderr.some((l) => l.includes("dropped")), stderr.join(""));
});

test("with testLocationInResults on and every location present there is no derivation notice", async () => {
  const { stderr, seen } = await runReporter(
    resultsOf([jestAssertion("child ok", 6)]),
    {},
    { testLocationInResults: true },
  );
  assert.equal(seen[0]!.body.specs[0]!.line_number, 6);
  assert.ok(!stderr.some((l) => l.includes("derived from the test source")), stderr.join(""));
});

test("a location missing despite testLocationInResults gets the notice worded for that case", async () => {
  const { stderr } = await runReporter(
    resultsOf([{ ...jestAssertion("child ok", 1), location: null }]),
    {},
    { testLocationInResults: true },
  );
  const notice = stderr.find((l) => l.includes("derived from the test source"));
  assert.ok(notice?.includes("despite `testLocationInResults`"), stderr.join(""));
});

test("a row with an unusable name is still dropped with the dropped warning", async () => {
  const { stderr, seen } = await runReporter(resultsOf([{ ...jestAssertion("x", 1), title: "" }]));
  assert.equal(seen.length, 0); // every row dropped -> zero rows -> no POST
  assert.ok(stderr.some((line) => line.includes("dropped 1")), stderr.join(""));
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
        kind: null,
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

test("globalConfig.shard.shardIndex supplies shard_id (index only, as a string) when nothing else names the shard", async () => {
  const { seen } = await runReporter(
    resultsOf([jestAssertion("a", 1)]),
    { env: env({ shardId: null }) },
    { shard: { shardIndex: 2, shardCount: 4 } },
  );
  assert.equal(seen[0]!.body.shard_id, "2");
});

test("an already-resolved shard_id beats globalConfig.shard", async () => {
  const { seen } = await runReporter(
    resultsOf([jestAssertion("a", 1)]),
    { env: env({ shardId: "macos-1" }) },
    { shard: { shardIndex: 2, shardCount: 4 } },
  );
  assert.equal(seen[0]!.body.shard_id, "macos-1");
});

test("no globalConfig.shard, or a malformed one, leaves shard_id null and never throws", async () => {
  for (const globalConfig of [
    undefined,
    null,
    "nope",
    {},
    { shard: null },
    { shard: {} },
    { shard: { shardIndex: "x", shardCount: 4 } },
    { shard: { shardIndex: 0, shardCount: 4 } },
    { shard: "2/4" },
  ]) {
    const { seen } = await runReporter(
      resultsOf([jestAssertion("a", 1)]),
      { env: env({ shardId: null }) },
      globalConfig,
    );
    assert.equal(seen[0]!.body.shard_id, null, JSON.stringify(globalConfig));
  }
});
