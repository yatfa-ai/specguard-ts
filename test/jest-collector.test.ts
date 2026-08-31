import { test } from "node:test";
import assert from "node:assert/strict";

import { JestCollector, type JestAssertionResult, type JestSuiteResult, type JestRunResult } from "../src/jest/collector.js";

/** A finished Jest assertion result, shaped exactly as Jest 30 hands it over. */
function jestAssertion(overrides: Partial<JestAssertionResult> & { title: string }): JestAssertionResult {
  return {
    ancestorTitles: [],
    fullName: overrides.title, // Jest's own space-joined composition (measured)
    location: { line: 10, column: 1 },
    status: "passed",
    duration: 1500,
    ...overrides,
  };
}

/** A finished Jest suite result wrapping `assertions`. */
function suite(
  assertions: JestAssertionResult[],
  testFilePath = "/repo/fixtures/jest/mixed.test.js",
): JestSuiteResult {
  return { testFilePath, testResults: assertions };
}

function collect(suites: JestSuiteResult[], repoRoot = "/repo"): JestCollector {
  const collector = new JestCollector(repoRoot, 1_000);
  collector.onRunComplete({ testResults: suites } satisfies JestRunResult);
  return collector;
}

test("maps status/duration/coordinates onto a row: passed, seconds, repo-relative path", () => {
  const collector = collect([suite([jestAssertion({ title: "plain" })])]);
  const rows = collector.getRows();
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.name, "plain");
  assert.equal(row.file_path, "fixtures/jest/mixed.test.js"); // /repo stripped
  assert.equal(row.line_number, 10); // the it( call line, 1-based
  assert.equal(row.duration, 1.5); // 1500 ms -> 1.5 s, converted at the edge
  assert.equal(row.outcome, "passed");
  assert.equal(row.status, "unannotated");
  assert.equal(row.intent, null);
  assert.equal(row.id.length > 0, true);
});

test("composed names are RECOMPOSED from ancestorTitles + title with ' > ', fullName's space join never trusted", () => {
  const collector = collect([
    suite([
      jestAssertion({
        title: "leaf",
        ancestorTitles: ["outer suite", "inner suite"],
        fullName: "outer suite inner suite leaf", // Jest's measured composition
      }),
    ]),
  ]);
  assert.equal(collector.getRows()[0]!.name, "outer suite > inner suite > leaf");
  assert.ok(!collector.getRows()[0]!.name.includes("mixed.test.ts"));
});

test("failed maps to failed; skip-family (pending/todo/skipped/disabled) map to pending with duration null", () => {
  const collector = collect([
    suite([
      jestAssertion({ title: "fails", status: "failed" }),
      jestAssertion({ title: "it-skip", status: "pending", duration: null }),
      jestAssertion({ title: "it-todo", status: "todo", duration: null }),
      jestAssertion({ title: "skipped", status: "skipped", duration: null, location: { line: 2, column: 1 } }),
      jestAssertion({ title: "disabled", status: "disabled", duration: null, location: { line: 3, column: 1 } }),
    ]),
  ]);
  const byName = new Map(collector.getRows().map((r) => [r.name, r]));
  assert.equal(byName.get("fails")!.outcome, "failed");
  assert.equal(byName.get("it-skip")!.outcome, "pending");
  assert.equal(byName.get("it-todo")!.outcome, "pending");
  assert.equal(byName.get("skipped")!.outcome, "pending");
  assert.equal(byName.get("disabled")!.outcome, "pending");
  assert.equal(byName.get("it-skip")!.duration, null);
  assert.equal(byName.get("it-todo")!.duration, null);
  assert.equal(collector.dropped, 0);
});

test("a null location (no testLocationInResults) drops the row, counted", () => {
  const collector = collect([
    suite([
      jestAssertion({ title: "no-loc", location: null }),
      jestAssertion({ title: "kept", location: { line: 4, column: 1 } }),
    ]),
  ]);
  assert.equal(collector.getRows().length, 1);
  assert.equal(collector.getRows()[0]!.name, "kept");
  assert.equal(collector.dropped, 1);
});

test("an unrecognized status is not a result: dropped, not guessed", () => {
  const collector = collect([
    suite([jestAssertion({ title: "unknown", status: "flaky" })]),
  ]);
  assert.equal(collector.getRows().length, 0);
  assert.equal(collector.dropped, 1);
});

test("a missing title drops the row: name is required on the wire when intent is null", () => {
  const collector = collect([
    suite([jestAssertion({ title: "", fullName: "whatever fullName says" })]),
    suite([jestAssertion({ title: "", fullName: "", ancestorTitles: ["only ancestors"] })]),
  ]);
  assert.equal(collector.getRows().length, 0);
  assert.equal(collector.dropped, 2);
});
test("empty-string ancestors never contribute a segment to the composed name", () => {
  const collector = collect([
    suite([jestAssertion({ title: "leaf", ancestorTitles: ["", "outer", ""] })]),
  ]);
  assert.equal(collector.getRows()[0]!.name, "outer > leaf");
});

test("a non-positive or non-integer line drops the row — the payload is refused otherwise", () => {
  const collector = collect([
    suite([
      jestAssertion({ title: "zero", location: { line: 0, column: 1 } }),
      jestAssertion({ title: "frac", location: { line: 1.5, column: 1 } }),
      jestAssertion({ title: "negative", location: { line: -3, column: 1 } }),
    ]),
  ]);
  assert.equal(collector.getRows().length, 0);
  assert.equal(collector.dropped, 3);
});

test("a suite outside the repo root keeps its absolute path, never a ../ escape", () => {
  const collector = collect([suite([jestAssertion({ title: "outside" })], "/elsewhere/lib/src/x.test.js")]);
  assert.equal(collector.getRows()[0]!.file_path, "/elsewhere/lib/src/x.test.js");
});

test("a non-absolute testFilePath passes through normalized to posix separators", () => {
  const collector = collect([suite([jestAssertion({ title: "virtual" })], "virtual/some-id")]);
  assert.equal(collector.getRows()[0]!.file_path, "virtual/some-id");
});

test("ids are stable across collectors and unique within a run", () => {
  const mk = () =>
    collect([suite([jestAssertion({ title: "outer > a" }), jestAssertion({ title: "outer > b", location: { line: 11, column: 1 } })])])
      .getRows()
      .map((r) => r.id);
  const a = mk();
  const b = mk();
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length);
});

test("duration discipline: negative or non-finite durations ship null, not a lie", () => {
  const collector = collect([
    suite([
      jestAssertion({ title: "negative", duration: -5 }),
      jestAssertion({ title: "infinite", duration: Number.POSITIVE_INFINITY }),
      jestAssertion({ title: "none", duration: undefined }),
    ]),
  ]);
  const byName = new Map(collector.getRows().map((r) => [r.name, r]));
  assert.equal(byName.get("negative")!.duration, null);
  assert.equal(byName.get("infinite")!.duration, null);
  assert.equal(byName.get("none")!.duration, null);
});

test("never throws: hostile results objects are skipped, never fatal", () => {
  const hostile: [unknown, number][] = [
    [null, 0],
    ["a string", 0],
    [undefined, 0],
    [{}, 0],
    [{ testResults: "not-an-array" }, 0],
    [{ testResults: [null, "suite", {}] }, 0],
    [
      {
        testResults: [
          {
            testFilePath: "/repo/x.test.js",
            testResults: [
              {
                title: "poison",
                ancestorTitles: [],
                location: { line: 3, column: 1 },
                status: "passed",
                // duration absent -> ships with duration null, still a row
              },
            ],
          },
        ],
      },
      1,
    ],
  ];
  for (const [results, expectedRows] of hostile) {
    const collector = new JestCollector("/repo", 1_000);
    collector.onRunComplete(results);
    assert.equal(collector.getRows().length, expectedRows);
  }
});

test("durationSeconds is wall-clock seconds since the reporter's start", () => {
  const collector = new JestCollector("/repo", 1_000);
  assert.equal(collector.durationSeconds(2_500), 1.5);
  assert.equal(collector.durationSeconds(500), 0); // never negative
});
