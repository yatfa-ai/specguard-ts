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

/** Collect with an in-memory "filesystem": path -> source text (missing path = unreadable). */
function collectWithSources(
  suites: JestSuiteResult[],
  sources: Record<string, string>,
): JestCollector {
  const reads: string[] = [];
  const collector = new JestCollector(
    "/repo",
    1_000,
    (path) => {
      reads.push(path);
      const text = sources[path];
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
  );
  collector.onRunComplete({ testResults: suites } satisfies JestRunResult);
  (collector as unknown as { reads: string[] }).reads = reads;
  return collector;
}

const SOURCE = [
  'describe("suite", () => {', //                1
  '  it("first", () => {});', //                 2
  "  // it(\"commented out\", () => {});", //    3
  '  it.only("second", () => {});', //           4
  "  test.concurrent('third', async () => {});", // 5
  "  it(", //                                    6
  '    "multi line",', //                        7
  "    () => {},", //                            8
  "  );", //                                     9
  '  it("dup", () => {});', //                  10
  '  it("dup", () => {});', //                  11
  '  it.each([1, 2])("each %i", () => {});', // 12
  "});",
].join("\n");

test("a null location (no testLocationInResults) derives the line from the suite's source, counted", () => {
  const collector = collectWithSources(
    [
      suite(
        [
          jestAssertion({ title: "first", location: null }),
          jestAssertion({ title: "second", location: undefined, ancestorTitles: ["suite"] }),
          jestAssertion({ title: "third", location: null }),
          jestAssertion({ title: "multi line", location: null }),
          jestAssertion({ title: "kept", location: { line: 4, column: 1 } }),
        ],
        "/repo/a.test.js",
      ),
    ],
    { "/repo/a.test.js": SOURCE },
  );
  const lines = Object.fromEntries(collector.getRows().map((r) => [r.name, r.line_number]));
  assert.deepEqual(lines, { first: 2, "suite > second": 4, third: 5, "multi line": 6, kept: 4 });
  assert.equal(collector.linesDerived, 4);
  assert.equal(collector.linesFallback, 0);
  assert.equal(collector.dropped, 0);
});

test("a commented-out call is not matched: its line is skipped", () => {
  const collector = collectWithSources(
    [suite([jestAssertion({ title: "commented out", location: null })], "/repo/a.test.js")],
    { "/repo/a.test.js": SOURCE },
  );
  assert.equal(collector.getRows()[0]!.line_number, 1);
  assert.equal(collector.linesFallback, 1);
});

test("repeated titles map to successive source occurrences in testResults order", () => {
  const collector = collectWithSources(
    [
      suite(
        [
          jestAssertion({ title: "dup", location: null }),
          jestAssertion({ title: "dup", location: null }),
          jestAssertion({ title: "dup", location: null }), // more results than source calls
        ],
        "/repo/a.test.js",
      ),
    ],
    { "/repo/a.test.js": SOURCE },
  );
  assert.deepEqual(collector.getRows().map((r) => r.line_number), [10, 11, 1]);
  assert.equal(collector.linesDerived, 2);
  assert.equal(collector.linesFallback, 1);
});

test("an it.each templated title falls back to line 1 rather than dropping the row", () => {
  const collector = collectWithSources(
    [
      suite(
        [
          jestAssertion({ title: "each 1", location: null }),
          jestAssertion({ title: "each 2", location: null }),
        ],
        "/repo/a.test.js",
      ),
    ],
    { "/repo/a.test.js": SOURCE },
  );
  assert.deepEqual(collector.getRows().map((r) => r.line_number), [1, 1]);
  assert.equal(collector.linesFallback, 2);
  assert.equal(collector.dropped, 0);
});

test("an unreadable source file falls back to line 1 for every row, never throws", () => {
  const collector = collectWithSources(
    [suite([jestAssertion({ title: "first", location: null })], "/repo/missing.test.js")],
    {},
  );
  assert.equal(collector.getRows().length, 1);
  assert.equal(collector.getRows()[0]!.line_number, 1);
  assert.equal(collector.linesFallback, 1);
  assert.equal(collector.dropped, 0);
});

test("the source is read once per suite, and not at all when Jest reported every location", () => {
  const derived = collectWithSources(
    [
      suite(
        [
          jestAssertion({ title: "first", location: null }),
          jestAssertion({ title: "second", location: null }),
        ],
        "/repo/a.test.js",
      ),
    ],
    { "/repo/a.test.js": SOURCE },
  );
  assert.deepEqual((derived as unknown as { reads: string[] }).reads, ["/repo/a.test.js"]);
  const exact = collectWithSources([suite([jestAssertion({ title: "first" })], "/repo/a.test.js")], {});
  assert.deepEqual((exact as unknown as { reads: string[] }).reads, []);
});

test("the row id does not depend on where the line came from", () => {
  const derived = collectWithSources(
    [suite([jestAssertion({ title: "first", location: null })], "/repo/a.test.js")],
    { "/repo/a.test.js": SOURCE },
  );
  const exact = collect([
    suite([jestAssertion({ title: "first", location: { line: 99, column: 1 } })], "/repo/a.test.js"),
  ]);
  assert.equal(derived.getRows()[0]!.id, exact.getRows()[0]!.id);
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

// --- A suite that fails to run at all -----------------------------------

const CRASH_SUITE = "/repo/fixtures/jest/crash.test.js";

test("a suite with testExecError and no assertions ships ONE failed row with the stable name", () => {
  const collector = collect([
    { testFilePath: CRASH_SUITE, testResults: [], testExecError: new Error("boom at import") },
  ]);
  const rows = collector.getRows();
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.file_path, "fixtures/jest/crash.test.js");
  assert.equal(row.line_number, 1);
  assert.equal(row.outcome, "failed");
  assert.equal(row.status, "unannotated");
  assert.equal(row.duration, null);
  assert.equal(row.name, "fixtures/jest/crash.test.js > (test file failed to run)");
  assert.equal(collector.dropped, 0);
});

test("empty testResults plus a non-empty failureMessage (no testExecError) also ships the row", () => {
  const collector = collect([
    { testFilePath: CRASH_SUITE, testResults: [], failureMessage: "  ● Test suite failed to run" },
  ]);
  assert.equal(collector.getRows().length, 1);
  assert.equal(collector.getRows()[0]!.outcome, "failed");
});

test("a healthy zero-test suite (no error, no failure message) ships nothing", () => {
  const collector = collect([{ testFilePath: CRASH_SUITE, testResults: [] }]);
  assert.equal(collector.getRows().length, 0);
  assert.equal(collector.dropped, 0);
});

test("a suite whose tests fail normally (non-empty failureMessage) does not gain a file row", () => {
  const collector = collect([
    {
      testFilePath: CRASH_SUITE,
      testResults: [jestAssertion({ title: "bad", status: "failed" })],
      failureMessage: "  ● bad",
    },
  ]);
  assert.deepEqual(collector.getRows().map((r) => r.name), ["bad"]);
});

test("a suite with an exec error AND a failed assertion of its own is not double-counted", () => {
  const collector = collect([
    {
      testFilePath: CRASH_SUITE,
      testResults: [jestAssertion({ title: "bad", status: "failed" })],
      testExecError: new Error("x"),
    },
  ]);
  assert.deepEqual(collector.getRows().map((r) => r.name), ["bad"]);
});

test("an all-skipped suite is not a failure", () => {
  const collector = collect([suite([jestAssertion({ title: "s", status: "pending" })])]);
  assert.deepEqual(collector.getRows().map((r) => r.outcome), ["pending"]);
});

test("a crashed suite with no usable path is dropped and counted", () => {
  const collector = new JestCollector("/repo", 1_000);
  collector.onRunComplete({ testResults: [{ testResults: [], testExecError: new Error("x") }] });
  assert.equal(collector.getRows().length, 0);
  assert.equal(collector.dropped, 1);
});
