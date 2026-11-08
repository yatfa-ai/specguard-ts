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

// ---------------------------------------------------------------------------
// Compiled-TypeScript mapping (SPGD-2125): JestCollector resolves a suite run
// from compiled output through the SAME SourceMapResolver the node:test
// collector uses. The fixtures below hand-make a map exactly like
// test/source-map.test.ts does, so every mapping arm is pinned at the
// collector level without needing a real `tsc`.
//
// Map: generated line 2 → source line 8, generated line 3 → source line 9
// (VLQ ";AAOA;AACA": line 0 empty; line 1 = [0,0,7,0]; line 2 = [0,0,1,0]).

import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

const MAPPINGS = ";AAOA;AACA";

const COMPILED = [
  '"use strict";',
  'it("alpha", () => { expect(1).toBe(1); });',
  'it("beta", () => { expect(2).toBe(2); });',
  "//# sourceMappingURL=a.test.js.map",
  "",
].join("\n");

/** A `.ts` file whose body only exists so a mapped source names a real file. */
const MAPPED_SOURCE = Array.from({ length: 12 }, (_, i) => `// source line ${i + 1}`).join("\n") + "\n";

function mappedProject(): { root: string; compiled: string; source: string; cleanup: () => void } {
  const root = fs.mkdtempSync(join(os.tmpdir(), "specguard-jest-sm-"));
  fs.mkdirSync(join(root, "dist"), { recursive: true });
  fs.mkdirSync(join(root, "src"), { recursive: true });
  const compiled = join(root, "dist", "a.test.js");
  fs.writeFileSync(compiled, COMPILED);
  const source = join(root, "src", "a.test.ts");
  fs.writeFileSync(source, MAPPED_SOURCE);
  fs.writeFileSync(
    join(root, "dist", "a.test.js.map"),
    JSON.stringify({ version: 3, file: "a.test.js", sources: ["../src/a.test.ts"], names: [], mappings: MAPPINGS }),
  );
  return { root, compiled, source, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("a Jest-REPORTED location keeps the TS line and remaps only the file (never double-mapped)", () => {
  const p = mappedProject();
  try {
    // With testLocationInResults Jest reports the source line itself (8);
    // resolving it again would map (8, 5) to line 9 — the corruption this
    // pin exists to catch.
    const collector = collect([
      { testFilePath: p.compiled, testResults: [jestAssertion({ title: "somewhere", location: { line: 8, column: 5 } })] },
    ], p.root);
    const row = collector.getRows()[0]!;
    assert.equal(row.file_path, "src/a.test.ts");
    assert.equal(row.line_number, 8);
  } finally {
    p.cleanup();
  }
});

test("a DERIVED line maps both the file and the line through the map", () => {
  const p = mappedProject();
  try {
    // No location: the line comes from the compiled source ("alpha" sits on
    // generated line 2), then maps to source line 8 under its source path.
    const collector = collect([
      { testFilePath: p.compiled, testResults: [jestAssertion({ title: "alpha", location: null })] },
    ], p.root);
    const row = collector.getRows()[0]!;
    assert.equal(row.file_path, "src/a.test.ts");
    assert.equal(row.line_number, 8);
    assert.equal(collector.linesDerived, 1);
    assert.equal(collector.linesFallback, 0);
  } finally {
    p.cleanup();
  }
});

test("a derived line that cannot map keeps the compiled path AND the compiled line", () => {
  const p = mappedProject();
  try {
    // "beta" sits on generated line 3, whose map entry points at source line
    // 9 — resolvable, so use a compiled file with NO map for the refusal arm.
    const bare = join(p.root, "dist", "bare.test.js");
    fs.writeFileSync(bare, 'it("gamma", () => {});\n');
    const collector = collect([
      { testFilePath: bare, testResults: [jestAssertion({ title: "gamma", location: null })] },
    ], p.root);
    const row = collector.getRows()[0]!;
    assert.equal(row.file_path, "dist/bare.test.js");
    assert.equal(row.line_number, 1);
    assert.equal(collector.linesDerived, 1);
  } finally {
    p.cleanup();
  }
});

test("a derived line whose map entry is missing keeps the compiled line (never a compiled line under a source path)", () => {
  const p = mappedProject();
  try {
    // The copied map's only mapping is on generated line 3, so the "tail"
    // call on generated line 1 — BEFORE any mapping — has no entry for its
    // position: resolve answers null and the row keeps BOTH compiled
    // coordinates, the compiled path AND compiled line 1.
    const tail = join(p.root, "dist", "tail.test.js");
    fs.writeFileSync(
      tail,
      [
        'it("tail", () => {});',
        'it("filler", () => {});',
        "//# sourceMappingURL=a.test.js.map",
        "",
      ].join("\n"),
    );
    fs.cpSync(join(p.root, "dist", "a.test.js.map"), join(p.root, "dist", "tail.test.js.map"));
    const collector = collect([
      { testFilePath: tail, testResults: [jestAssertion({ title: "tail", location: null })] },
    ], p.root);
    const row = collector.getRows()[0]!;
    assert.equal(row.file_path, "dist/tail.test.js");
    assert.equal(row.line_number, 1);
  } finally {
    p.cleanup();
  }
});

test("the line-1 fallback is synthetic: its line stays 1, only the file is remapped", () => {
  const p = mappedProject();
  try {
    const collector = collect([
      { testFilePath: p.compiled, testResults: [jestAssertion({ title: "not in the compiled source", location: null })] },
    ], p.root);
    const row = collector.getRows()[0]!;
    assert.equal(row.file_path, "src/a.test.ts");
    assert.equal(row.line_number, 1);
    assert.equal(collector.linesFallback, 1);
    assert.equal(collector.linesDerived, 0);
  } finally {
    p.cleanup();
  }
});

test("a `.ts` testFilePath (ts-jest / babel-jest shape) ships byte-identical rows", () => {
  const p = mappedProject();
  try {
    // The extension guard: a `.ts` suite is never looked at for a map —
    // reported lines and derived lines alike ship exactly as they arrived.
    const tsPath = join(p.root, "src", "c.test.ts");
    fs.writeFileSync(tsPath, 'it("epsilon", () => {});\nit("zeta", () => {});\n');
    const collector = collect([
      {
        testFilePath: tsPath,
        testResults: [
          jestAssertion({ title: "epsilon", location: null }),
          jestAssertion({ title: "zeta", location: { line: 2, column: 1 } }),
        ],
      },
    ], p.root);
    const [epsilon, zeta] = collector.getRows();
    assert.equal(epsilon!.file_path, "src/c.test.ts");
    assert.equal(epsilon!.line_number, 1);
    assert.equal(zeta!.file_path, "src/c.test.ts");
    assert.equal(zeta!.line_number, 2);
  } finally {
    p.cleanup();
  }
});

test("a crashed compiled suite's file-failure row is named by its source path", () => {
  const p = mappedProject();
  try {
    const collector = new JestCollector(p.root, 1_000);
    collector.onRunComplete({
      testResults: [{ testFilePath: p.compiled, testResults: [], testExecError: new Error("boom") }],
    });
    const row = collector.getRows()[0]!;
    assert.equal(row.name, "src/a.test.ts > (test file failed to run)");
    assert.equal(row.file_path, "src/a.test.ts");
    assert.equal(row.line_number, 1);
    assert.equal(row.outcome, "failed");
  } finally {
    p.cleanup();
  }
});

test("a crashed compiled suite with no usable map is named by its compiled path", () => {
  const p = mappedProject();
  try {
    fs.rmSync(join(p.root, "dist", "a.test.js.map"));
    const collector = new JestCollector(p.root, 1_000);
    collector.onRunComplete({
      testResults: [{ testFilePath: p.compiled, testResults: [], testExecError: new Error("boom") }],
    });
    const row = collector.getRows()[0]!;
    assert.equal(row.name, "dist/a.test.js > (test file failed to run)");
    assert.equal(row.file_path, "dist/a.test.js");
  } finally {
    p.cleanup();
  }
});
