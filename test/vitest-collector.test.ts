import { test } from "node:test";
import assert from "node:assert/strict";

import {
  VitestCollector,
  type VitestTestCase,
  type VitestTestModule,
  type VitestTestSuite,
} from "../src/vitest/collector.js";

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

// --- A module that fails to run at all ----------------------------------

function crashedModule(
  errors: readonly unknown[] | (() => never),
  moduleId = "/repo/fixtures/vitest/crash.test.ts",
): VitestTestModule {
  return {
    type: "module",
    moduleId,
    children: { allTests: () => [][Symbol.iterator]() },
    errors: typeof errors === "function" ? errors : () => errors,
  };
}

test("a module with zero tests and module errors ships ONE failed row with the stable name", () => {
  const collector = collect([crashedModule([new Error("boom at import")])]);
  const rows = collector.getRows();
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.file_path, "fixtures/vitest/crash.test.ts");
  assert.equal(row.line_number, 1);
  assert.equal(row.outcome, "failed");
  assert.equal(row.status, "unannotated");
  assert.equal(row.duration, null);
  assert.equal(row.name, "fixtures/vitest/crash.test.ts > (test file failed to run)");
  assert.equal(collector.dropped, 0);
});

test("the Vitest crash row is byte-identical to the one node:test would ship for the same file", () => {
  const collector = collect([crashedModule([new Error("x")], "/repo/test/crash.test.js")]);
  assert.equal(collector.getRows()[0]!.name, "test/crash.test.js > (test file failed to run)");
});

test("a genuinely empty module (zero tests, no errors — e.g. all filtered out) ships nothing", () => {
  const collector = collect([crashedModule([])]);
  assert.equal(collector.getRows().length, 0);
  assert.equal(collector.dropped, 0);
});

test("a module with tests never gains a file row, even when it also reports module errors", () => {
  const mod = module([vitestTest({ name: "t", result: () => ({ state: "failed" }) })]);
  mod.errors = () => [new Error("afterAll hook failed")];
  const collector = collect([mod]);
  assert.deepEqual(collector.getRows().map((r) => r.name), ["t"]);
});

test("an all-skipped module (state skipped, tests present, no errors) is not a failure", () => {
  const collector = collect([
    module([vitestTest({ name: "s", result: () => ({ state: "skipped" }) })]),
  ]);
  assert.deepEqual(collector.getRows().map((r) => r.outcome), ["pending"]);
});

test("a module whose errors() throws is dropped and counted, never thrown", () => {
  const collector = collect([
    crashedModule(() => {
      throw new Error("hostile");
    }),
  ]);
  assert.equal(collector.getRows().length, 0);
  assert.equal(collector.dropped, 1);
});

test("a crashed module with no usable module id is dropped and counted", () => {
  const mod = crashedModule([new Error("x")]);
  delete (mod as { moduleId?: string }).moduleId;
  const collector = collect([mod]);
  assert.equal(collector.getRows().length, 0);
  assert.equal(collector.dropped, 1);
});

// --- Setup / teardown hook failures in a file that DID run ---------------

const HOOK_FILE = "/repo/fixtures/vitest/hook.test.ts";
const HOOK_ROW_NAME = "fixtures/vitest/hook.test.ts > (test file failed to run)";

function suite(state: string, errors: readonly unknown[] | (() => never)): VitestTestSuite {
  return { state: () => state, errors: typeof errors === "function" ? errors : () => errors };
}

/** A module that ran tests and reports `suites` / module `errors`. */
function hookModule(
  tests: VitestTestCase[],
  opts: { suites?: VitestTestSuite[]; errors?: readonly unknown[] } = {},
): VitestTestModule {
  return {
    type: "module",
    moduleId: HOOK_FILE,
    children: {
      allTests: () => tests[Symbol.iterator](),
      allSuites: () => (opts.suites ?? [])[Symbol.iterator](),
    },
    errors: () => opts.errors ?? [],
  };
}

test("a throwing describe-level afterAll (passing test, failed suite with errors) ships ONE file row beside the test's own row", () => {
  const collector = collect([
    hookModule([vitestTest({ name: "teardown > still passes" })], {
      suites: [suite("failed", [new Error("afterAll boom")])],
    }),
  ]);
  const rows = collector.getRows();
  assert.deepEqual(rows.map((r) => [r.name, r.outcome]), [
    ["teardown > still passes", "passed"],
    [HOOK_ROW_NAME, "failed"],
  ]);
  assert.equal(rows[1]!.line_number, 1);
  assert.equal(rows[1]!.duration, null);
  assert.equal(collector.dropped, 0);
});

test("a throwing beforeAll keeps its tests pending and still turns the file red with one row", () => {
  const collector = collect([
    hookModule([vitestTest({ name: "setup > never runs", result: () => ({ state: "skipped" }) })], {
      suites: [suite("failed", [new Error("beforeAll boom")])],
    }),
  ]);
  assert.deepEqual(collector.getRows().map((r) => [r.name, r.outcome]), [
    ["setup > never runs", "pending"],
    [HOOK_ROW_NAME, "failed"],
  ]);
});

test("a throwing top-level afterAll (module errors, passing test) ships ONE file row", () => {
  const collector = collect([
    hookModule([vitestTest({ name: "still passes" })], { errors: [new Error("top-level afterAll boom")] }),
  ]);
  assert.deepEqual(collector.getRows().map((r) => [r.name, r.outcome]), [
    ["still passes", "passed"],
    [HOOK_ROW_NAME, "failed"],
  ]);
});

test("the hook row reuses the crash row's name byte for byte (the name is a wire contract)", () => {
  const hook = collect([
    hookModule([vitestTest({ name: "t" })], { errors: [new Error("x")] }),
  ]).getRows()[1]!;
  const crash = collect([crashedModule([new Error("x")], HOOK_FILE)]).getRows()[0]!;
  assert.equal(hook.name, crash.name);
  assert.equal(hook.id, crash.id);
});

test("a file with a failed row of its own gains no hook row, however many suites report errors", () => {
  const collector = collect([
    hookModule([vitestTest({ name: "fails itself", result: () => ({ state: "failed" }) })], {
      suites: [suite("failed", [new Error("a")]), suite("failed", [new Error("b")])],
      errors: [new Error("c")],
    }),
  ]);
  assert.deepEqual(collector.getRows().map((r) => r.name), ["fails itself"]);
});

test("two failing suites in a file with no failed row still ship ONE row, not one per suite", () => {
  const collector = collect([
    hookModule([vitestTest({ name: "t" })], {
      suites: [suite("failed", [new Error("a")]), suite("failed", [new Error("b")])],
    }),
  ]);
  assert.equal(collector.getRows().filter((r) => r.name === HOOK_ROW_NAME).length, 1);
});

test("a suite that is failed only because a child failed (empty errors) adds nothing", () => {
  const collector = collect([
    hookModule([vitestTest({ name: "t" })], { suites: [suite("failed", [])] }),
  ]);
  assert.deepEqual(collector.getRows().map((r) => r.name), ["t"]);
});

test("a passed suite with stray errors, and a healthy module, add nothing", () => {
  const collector = collect([
    hookModule([vitestTest({ name: "t" })], { suites: [suite("passed", [new Error("x")])] }),
    module([vitestTest({ name: "plain" })]),
  ]);
  assert.deepEqual(collector.getRows().map((r) => r.name), ["t", "plain"]);
});

test("older Vitest without allSuites / suite.errors is read as 'nothing reported', never a throw", () => {
  const noAllSuites = hookModule([vitestTest({ name: "a" })]);
  delete (noAllSuites.children as { allSuites?: unknown }).allSuites;
  const noSuiteErrors = hookModule([vitestTest({ name: "b" })], { suites: [{ state: () => "failed" }] });
  const collector = collect([noAllSuites, noSuiteErrors]);
  assert.deepEqual(collector.getRows().map((r) => r.name), ["a", "b"]);
  assert.equal(collector.dropped, 0);
});

test("a suite whose errors() throws is dropped and counted, never thrown", () => {
  const collector = collect([
    hookModule([vitestTest({ name: "t" })], {
      suites: [
        suite("failed", () => {
          throw new Error("hostile");
        }),
      ],
    }),
  ]);
  assert.deepEqual(collector.getRows().map((r) => r.name), ["t"]);
  assert.equal(collector.dropped, 1);
});

test("a hook failure in a module with no usable module id is dropped and counted", () => {
  const mod = hookModule([vitestTest({ name: "t" })], { errors: [new Error("x")] });
  delete (mod as { moduleId?: string }).moduleId;
  const collector = new VitestCollector("/repo", 1_000);
  collector.onTestRunEnd([mod]);
  assert.equal(collector.getRows().length, 0); // the test row needs the id too
  assert.ok(collector.dropped >= 1);
});

// ---- run-level unhandled errors (SPGD-2086) --------------------------------

const UNHANDLED_ROW_NAME = "fixtures/vitest/mixed.test.ts > (test file failed to run)";
const MIXED_ID = "/repo/fixtures/vitest/mixed.test.ts";

function collectWithErrors(mods: VitestTestModule[], errors: unknown): VitestCollector {
  const collector = new VitestCollector("/repo", 1_000);
  collector.onTestRunEnd(mods, errors);
  return collector;
}

test("unhandled errors in a passing file ship exactly one failed file row, however many errors", () => {
  const collector = collectWithErrors(
    [module([vitestTest({ name: "ok" })])],
    [
      { type: "Uncaught Exception", VITEST_TEST_PATH: MIXED_ID },
      { type: "Unhandled Rejection", VITEST_TEST_PATH: MIXED_ID },
    ],
  );
  const rows = collector.getRows();
  assert.deepEqual(rows.map((r) => [r.name, r.outcome, r.line_number, r.duration]), [
    ["ok", "passed", 10, 1.5],
    [UNHANDLED_ROW_NAME, "failed", 1, null],
  ]);
  assert.equal(collector.unattributedErrors, 0);
});

test("an unhandled error in a file with a failing test adds no extra row", () => {
  const failing = vitestTest({ name: "bad", result: () => ({ state: "failed" }) });
  const collector = collectWithErrors([module([failing])], [{ VITEST_TEST_PATH: MIXED_ID }]);
  assert.deepEqual(collector.getRows().map((r) => r.name), ["bad"]);
  assert.equal(collector.unattributedErrors, 0);
});

test("a file already given a file-failure row (module error) is not double-counted by an unhandled error", () => {
  const crashed: VitestTestModule = { ...module([]), errors: () => [new Error("load")] };
  const collector = collectWithErrors([crashed], [{ VITEST_TEST_PATH: MIXED_ID }]);
  assert.deepEqual(collector.getRows().map((r) => r.name), [UNHANDLED_ROW_NAME]);
});

test("unhandled errors only mark their own file; others stay untouched", () => {
  const collector = collectWithErrors(
    [module([vitestTest({ name: "a" })]), module([vitestTest({ name: "b" })], "/repo/fixtures/vitest/other.test.ts")],
    [{ VITEST_TEST_PATH: "/repo/fixtures/vitest/other.test.ts" }],
  );
  assert.deepEqual(collector.getRows().map((r) => [r.file_path, r.name]), [
    ["fixtures/vitest/mixed.test.ts", "a"],
    ["fixtures/vitest/other.test.ts", "b"],
    ["fixtures/vitest/other.test.ts", "fixtures/vitest/other.test.ts > (test file failed to run)"],
  ]);
});

test("errors with no path or a path matching no module count as unattributed and ship no row", () => {
  const collector = collectWithErrors([module([vitestTest({ name: "ok" })])], [
    {},
    { VITEST_TEST_PATH: 5 },
    { VITEST_TEST_PATH: "/repo/not-collected.test.ts" },
    "string error",
  ]);
  assert.equal(collector.getRows().length, 1);
  assert.equal(collector.unattributedErrors, 4);
});

test("no errors, or a non-array errors argument, leaves the rows exactly as before", () => {
  for (const errors of [undefined, [], null, "x", {}]) {
    const collector = collectWithErrors([module([vitestTest({ name: "ok" })])], errors);
    assert.equal(collector.getRows().length, 1);
    assert.equal(collector.unattributedErrors, 0);
  }
});
