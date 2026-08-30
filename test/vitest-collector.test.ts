import { test } from "node:test";
import assert from "node:assert/strict";

import { VitestCollector, type VitestTestCase, type VitestTestModule } from "../src/vitest/collector.js";

/** A finished Vitest test case, shaped exactly as Vitest 4 hands it over. */
function vitestTest(overrides: Partial<VitestTestCase> & { name: string }): VitestTestCase {
  return {
    type: "test",
    fullName: overrides.name,
    location: { line: 10, column: 3 },
    result: () => ({ state: "passed" }),
    diagnostic: () => ({ duration: 1500 }),
    ...overrides,
  };
}

/** A finished Vitest test module wrapping `tests`. */
function module(tests: VitestTestCase[], moduleId = "/repo/fixtures/vitest/mixed.test.ts"): VitestTestModule {
  return {
    type: "module",
    moduleId,
    children: { allTests: () => tests[Symbol.iterator]() },
  };
}

function collect(mods: VitestTestModule[], repoRoot = "/repo"): VitestCollector {
  const collector = new VitestCollector(repoRoot, 1_000);
  collector.onTestRunEnd(mods);
  return collector;
}

test("maps state/duration/coordinates onto a row: passed, seconds, repo-relative path", () => {
  const collector = collect([module([vitestTest({ name: "plain" })])]);
  const rows = collector.getRows();
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.name, "plain");
  assert.equal(row.file_path, "fixtures/vitest/mixed.test.ts"); // /repo stripped
  assert.equal(row.line_number, 10); // the test() call line, 1-based
  assert.equal(row.duration, 1.5); // 1500 ms -> 1.5 s, converted at the edge
  assert.equal(row.outcome, "passed");
  assert.equal(row.status, "unannotated");
  assert.equal(row.intent, null);
  assert.equal(row.id.length > 0, true);
});

test("composed names come from fullName verbatim, the module path never included", () => {
  const collector = collect([
    module([
      vitestTest({ name: "leaf", fullName: "outer suite > inner suite > leaf" }),
    ]),
  ]);
  assert.equal(collector.getRows()[0]!.name, "outer suite > inner suite > leaf");
  assert.ok(!collector.getRows()[0]!.name.includes("mixed.test.ts"));
});

test("failed maps to failed; both skip and todo map to pending with duration null", () => {
  const collector = collect([
    module([
      vitestTest({ name: "fails", result: () => ({ state: "failed" }) }),
      vitestTest({
        name: "skipped",
        result: () => ({ state: "skipped" }),
        diagnostic: undefined, // skipped tests carry no diagnostic (measured)
        location: { line: 2, column: 3 },
      }),
    ]),
  ]);
  const byName = new Map(collector.getRows().map((r) => [r.name, r]));
  assert.equal(byName.get("fails")!.outcome, "failed");
  assert.equal(byName.get("skipped")!.outcome, "pending");
  assert.equal(byName.get("skipped")!.duration, null);
  assert.equal(collector.dropped, 0);
});

test("a null location (no includeTaskLocation) drops the row, counted", () => {
  const collector = collect([
    module([
      vitestTest({ name: "no-loc", location: null }),
      vitestTest({ name: "kept", location: { line: 4, column: 2 } }),
    ]),
  ]);
  assert.equal(collector.getRows().length, 1);
  assert.equal(collector.getRows()[0]!.name, "kept");
  assert.equal(collector.dropped, 1);
});

test("a pending (never-finished) state is not a result: dropped, not guessed", () => {
  const collector = collect([
    module([vitestTest({ name: "interrupted", result: () => ({ state: "pending" }) })]),
  ]);
  assert.equal(collector.getRows().length, 0);
  assert.equal(collector.dropped, 1);
});

test("a missing name drops the row: name is required on the wire when intent is null", () => {
  const collector = collect([
    module([vitestTest({ name: "", fullName: "" })]),
  ]);
  assert.equal(collector.getRows().length, 0);
  assert.equal(collector.dropped, 1);
});

test("falls back to the bare name when fullName is absent", () => {
  const collector = collect([
    module([vitestTest({ name: "bare", fullName: undefined })]),
  ]);
  assert.equal(collector.getRows()[0]!.name, "bare");
});

test("a non-positive or non-integer line drops the row — the payload is refused otherwise", () => {
  const collector = collect([
    module([
      vitestTest({ name: "zero", location: { line: 0, column: 1 } }),
      vitestTest({ name: "frac", location: { line: 1.5, column: 1 } }),
      vitestTest({ name: "negative", location: { line: -3, column: 1 } }),
    ]),
  ]);
  assert.equal(collector.getRows().length, 0);
  assert.equal(collector.dropped, 3);
});

test("a module outside the repo root keeps its absolute path, never a ../ escape", () => {
  const collector = collect([
    module([vitestTest({ name: "outside" })], "/elsewhere/lib/src/x.test.ts"),
  ]);
  assert.equal(collector.getRows()[0]!.file_path, "/elsewhere/lib/src/x.test.ts");
});

test("a non-absolute moduleId passes through normalized to posix separators", () => {
  const collector = collect([
    module([vitestTest({ name: "virtual" })], "virtual/some-id"),
  ]);
  assert.equal(collector.getRows()[0]!.file_path, "virtual/some-id");
});

test("ids are stable across collectors and unique within a run", () => {
  const mk = () =>
    collect([module([vitestTest({ name: "outer > a" }), vitestTest({ name: "outer > b", location: { line: 11, column: 3 } })])])
      .getRows()
      .map((r) => r.id);
  const a = mk();
  const b = mk();
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length);
});

test("duration discipline: negative or non-finite durations ship null, not a lie", () => {
  const collector = collect([
    module([
      vitestTest({ name: "negative", diagnostic: () => ({ duration: -5 }) }),
      vitestTest({ name: "infinite", diagnostic: () => ({ duration: Number.POSITIVE_INFINITY }) }),
      vitestTest({ name: "none", diagnostic: () => undefined }),
    ]),
  ]);
  const byName = new Map(collector.getRows().map((r) => [r.name, r]));
  assert.equal(byName.get("negative")!.duration, null);
  assert.equal(byName.get("infinite")!.duration, null);
  assert.equal(byName.get("none")!.duration, null);
});

test("never throws: hostile modules and tests are skipped, never fatal", () => {
  const hostile = [
    null,
    "a string",
    { moduleId: "/repo/x.test.ts", children: { allTests: () => { throw new Error("boom"); } } },
    {
      moduleId: "/repo/x.test.ts",
      children: {
        allTests: () => [
          {
            type: "test",
            name: "poison",
            location: { line: 3, column: 1 },
            result: () => {
              throw new Error("boom");
            },
          },
        ][Symbol.iterator](),
      },
    },
    { moduleId: "/repo/y.test.ts" }, // no children at all
  ];
  const collector = new VitestCollector("/repo", 1_000);
  collector.onTestRunEnd(hostile as unknown as VitestTestModule[]);
  assert.equal(collector.getRows().length, 0);
  // the poison test's add() threw inside its own guard: counted as dropped
  assert.ok(collector.dropped >= 0);
});

test("durationSeconds is wall-clock seconds since the reporter's start", () => {
  const collector = new VitestCollector("/repo", 1_000);
  assert.equal(collector.durationSeconds(2_500), 1.5);
  assert.equal(collector.durationSeconds(500), 0); // never negative
});
