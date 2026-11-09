import { test } from "node:test";
import assert from "node:assert/strict";
import { RunCollector } from "../src/node-test/collector.js";
import { exampleId } from "../src/core/id.js";

const ROOT = "/repo";
const FILE = "/repo/test/alpha.test.js";

function collector(): RunCollector {
  return new RunCollector(ROOT);
}

function start(collector: RunCollector, name: string, nesting: number): void {
  collector.onStart({ name, nesting });
}

function result(
  collector: RunCollector,
  name: string,
  nesting: number,
  line: number,
  extra: {
    kind?: "pass" | "fail";
    type?: string;
    durationMs?: number;
    skip?: boolean | string;
    todo?: boolean | string;
  } = {},
): void {
  collector.onResult(
    {
      name,
      nesting,
      file: FILE,
      line,
      skip: extra.skip === undefined ? undefined : extra.skip,
      todo: extra.todo === undefined ? undefined : extra.todo,
      details:
        extra.type === undefined && extra.durationMs === undefined
          ? undefined
          : {
              ...(extra.type === undefined ? {} : { type: extra.type }),
              ...(extra.durationMs === undefined
                ? {}
                : { duration_ms: extra.durationMs }),
            },
    },
    extra.kind ?? "pass",
  );
}

test("line_number is the positive integer from data.line, including nested tests", () => {
  const c = collector();
  start(c, "outer", 0);
  start(c, "top level passes", 1);
  result(c, "top level passes", 1, 4);
  start(c, "nested fails", 2);
  result(c, "nested fails", 2, 8, { kind: "fail" });
  result(c, "outer", 0, 2, { type: "suite" });

  const rows = c.getRows();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(Number.isInteger(row.line_number) && row.line_number > 0);
    assert.ok((row.line_number === 4 || row.line_number === 8) === true);
  }
});

test("suite events are excluded: N tests in M describes produce exactly N rows", () => {
  // 3 tests inside 3 describes (one nested) — 6 pass/fail events, 3 rows.
  const c = collector();
  start(c, "a", 0);
  start(c, "t1", 1);
  result(c, "t1", 1, 3);
  start(c, "b", 1);
  start(c, "t2", 2);
  result(c, "t2", 2, 6);
  result(c, "b", 1, 5, { type: "suite" });
  start(c, "c", 1);
  start(c, "t3", 2);
  result(c, "t3", 2, 10);
  result(c, "c", 1, 9, { type: "suite" });
  result(c, "a", 0, 2, { type: "suite" });

  assert.equal(c.getRows().length, 3);
});

test("a failing nested test is reported exactly once, not again through its parent suite", () => {
  const c = collector();
  start(c, "parent", 0);
  start(c, "child fails", 1);
  result(c, "child fails", 1, 8, { kind: "fail" });
  result(c, "parent", 0, 7, { kind: "fail", type: "suite" }); // suite re-emits the failure

  const rows = c.getRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.outcome, "failed");
});

test("duration is converted from milliseconds to seconds", () => {
  const c = collector();
  start(c, "sleeper", 0);
  result(c, "sleeper", 0, 3, { durationMs: 80 });
  const row = c.getRows()[0];
  assert.ok(row !== undefined);
  // The 1000x-wrong value (~80) fails this assertion by construction.
  assert.ok(
    row.duration !== null && row.duration >= 0.05 && row.duration <= 0.5,
    `duration ${String(row.duration)} not in [0.05, 0.5] — was it divided by 1000?`,
  );
});

test("duration is null when the runner reports none, never negative", () => {
  const c = collector();
  start(c, "t", 0);
  result(c, "t", 0, 3);
  assert.equal(c.getRows()[0]?.duration, null);
});

test("file_path is repo-relative, with no leading slash", () => {
  const c = collector();
  start(c, "t", 0);
  result(c, "t", 0, 3);
  const row = c.getRows()[0];
  assert.ok(row !== undefined);
  assert.equal(row.file_path, "test/alpha.test.js");
  assert.ok(!row.file_path.startsWith("/"));
});

test("name is the composed ancestry, not the leaf, at two nesting levels", () => {
  const c = collector();
  start(c, "outer suite", 0);
  start(c, "inner suite", 1);
  start(c, "child ok", 2);
  result(c, "child ok", 2, 5);
  result(c, "inner suite", 1, 4, { type: "suite" });
  result(c, "outer suite", 0, 3, { type: "suite" });

  assert.equal(
    c.getRows()[0]?.name,
    "outer suite > inner suite > child ok",
  );
});

test("a sibling suite replaces the previous suite name at its nesting level (LIFO pinned)", () => {
  // Suites close in strict LIFO order and files never interleave (measured,
  // not documented) — the second sibling's children must compose against the
  // SECOND suite's name, not the first's still-open... actually the first
  // sibling has already CLOSED before the second opens, so the stack is empty
  // at its level. This test pins that the composed name is right either way.
  const c = collector();
  start(c, "root", 0);
  start(c, "first", 1);
  start(c, "a1", 2);
  result(c, "a1", 2, 4);
  result(c, "first", 1, 3, { type: "suite" });
  start(c, "second", 1);
  start(c, "b1", 2);
  result(c, "b1", 2, 8);
  result(c, "second", 1, 7, { type: "suite" });
  result(c, "root", 0, 2, { type: "suite" });

  const rows = c.getRows();
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.name, "root > first > a1");
  assert.equal(rows[1]?.name, "root > second > b1");
});

test("a skipped test ships as pending, never silently as a pass", () => {
  const c = collector();
  start(c, "skipped one", 0);
  result(c, "skipped one", 0, 3, { skip: true });
  assert.equal(c.getRows()[0]?.outcome, "pending");
});

test("a reason-string skip and every todo test ship as pending", () => {
  const c = collector();
  const cases: Array<[string, { skip?: boolean | string; todo?: boolean | string }]> = [
    ["skip with reason", { skip: "flaky on CI" }],
    ["todo true", { todo: true }],
    ["todo with reason", { todo: "implement later" }],
  ];
  cases.forEach(([name, extra], i) => {
    start(c, name, 0);
    result(c, name, 0, i + 3, extra);
  });
  assert.deepEqual(c.getRows().map((r) => r.outcome), ["pending", "pending", "pending"]);
});

test("falsy skip/todo values (false, empty string) are not skip-family", () => {
  const c = collector();
  start(c, "plain", 0);
  result(c, "plain", 0, 3, { skip: false, todo: "" });
  assert.equal(c.getRows()[0]?.outcome, "passed");
});

test("a failing todo test ships pending, a genuine failure still ships failed", () => {
  const c = collector();
  start(c, "todo throws", 0);
  result(c, "todo throws", 0, 3, { kind: "fail", todo: "wip" });
  start(c, "real failure", 0);
  result(c, "real failure", 0, 6, { kind: "fail" });
  assert.deepEqual(c.getRows().map((r) => r.outcome), ["pending", "failed"]);
});

test("a failing todo is not a failed row: a later file-level failure still ships its crash row", () => {
  const c = collector();
  start(c, "todo throws", 0);
  result(c, "todo throws", 0, 3, { kind: "fail", todo: true });
  // the file-level event of a file that then failed on its own
  start(c, FILE, 0);
  c.onResult({ name: FILE, nesting: 0, file: FILE, line: 1 }, "fail");
  const rows = c.getRows();
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.outcome, "pending");
  assert.equal(rows[1]?.outcome, "failed");
});

test("a failed suite whose only failing child is a todo still ships its hook-failure file row", () => {
  const c = collector();
  start(c, "suite", 0);
  start(c, "todo throws", 1);
  result(c, "todo throws", 1, 4, { kind: "fail", todo: true });
  result(c, "suite", 0, 2, { kind: "fail", type: "suite" });
  const rows = c.getRows();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.outcome), ["pending", "failed"]);
});

test("every row carries a stable, unique id, identical across two identical runs", () => {
  const runA = collector();
  const runB = collector();
  for (const c of [runA, runB]) {
    start(c, "s", 0);
    start(c, "t1", 1);
    result(c, "t1", 1, 3);
    start(c, "t2", 1);
    result(c, "t2", 1, 6);
    result(c, "s", 0, 2, { type: "suite" });
  }
  const a = runA.getRows().map((r) => r.id);
  const b = runB.getRows().map((r) => r.id);
  assert.deepEqual(a, b); // stable across runs
  assert.equal(new Set(a).size, a.length); // unique within the payload
  assert.equal(a[0], exampleId("test/alpha.test.js", "s > t1"));
});

test("a row with no usable line or file is dropped, not sent", () => {
  const c = collector();
  start(c, "no line", 0);
  c.onResult({ name: "no line", file: FILE }, "pass");
  start(c, "ok", 0);
  result(c, "ok", 0, 5);
  assert.equal(c.getRows().length, 1);
  assert.equal(c.dropped, 1);
});

test("unannotated rows always carry status unannotated, intent null, and a name", () => {
  const c = collector();
  start(c, "t", 0);
  result(c, "t", 0, 3);
  const row = c.getRows()[0];
  assert.ok(row !== undefined);
  assert.equal(row.status, "unannotated");
  assert.equal(row.intent, null);
  assert.ok(typeof row.name === "string" && row.name.length > 0);
});

// --- A test file that fails to run at all -------------------------------

const CRASH_FILE = "/repo/test/crash.test.js";

function fileEvent(
  c: RunCollector,
  name: string,
  kind: "pass" | "fail",
  extra: { file?: string; durationMs?: number } = {},
): void {
  c.onStart({ name, nesting: 0 });
  c.onResult(
    {
      name,
      nesting: 0,
      file: extra.file ?? CRASH_FILE,
      line: 1,
      column: 1,
      details: extra.durationMs === undefined ? {} : { duration_ms: extra.durationMs },
    },
    kind,
  );
}

test("a file-level test:fail (absolute-path name, Node 20) ships ONE failed row with a stable relative name", () => {
  const c = collector();
  fileEvent(c, CRASH_FILE, "fail", { durationMs: 40 });
  const rows = c.getRows();
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.file_path, "test/crash.test.js");
  assert.equal(row.line_number, 1);
  assert.equal(row.outcome, "failed");
  assert.equal(row.status, "unannotated");
  assert.equal(row.intent, null);
  assert.equal(row.duration, 0.04);
  // The name is pinned: platform identity is semantic over it, so a change
  // re-identifies every crashed file in history.
  assert.equal(row.name, "test/crash.test.js > (test file failed to run)");
  assert.equal(row.id, exampleId("test/crash.test.js", row.name));
  assert.equal(c.dropped, 0);
});

test("a file-level test:fail named with a cwd-relative path (newer Node) ships the SAME row as the absolute spelling", () => {
  const absolute = collector();
  fileEvent(absolute, CRASH_FILE, "fail");
  const relativeSpelling = new RunCollector(process.cwd());
  fileEvent(relativeSpelling, "test/crash.test.js", "fail", {
    file: `${process.cwd()}/test/crash.test.js`,
  });
  assert.equal(relativeSpelling.getRows().length, 1);
  assert.equal(relativeSpelling.getRows()[0]!.name, absolute.getRows()[0]!.name);
});

test("the crash row has no machine-specific path in its name or id", () => {
  const a = new RunCollector("/home/alice/proj");
  fileEvent(a, "/home/alice/proj/test/crash.test.js", "fail", { file: "/home/alice/proj/test/crash.test.js" });
  const b = new RunCollector("/ci/work");
  fileEvent(b, "/ci/work/test/crash.test.js", "fail", { file: "/ci/work/test/crash.test.js" });
  assert.equal(a.getRows()[0]!.name, b.getRows()[0]!.name);
  assert.equal(a.getRows()[0]!.id, b.getRows()[0]!.id);
});

test("a healthy zero-test file (synthetic file-level pass) still ships nothing, under both name spellings", () => {
  const c = new RunCollector(process.cwd());
  fileEvent(c, CRASH_FILE, "pass", { file: CRASH_FILE });
  fileEvent(c, "test/empty.test.js", "pass", { file: `${process.cwd()}/test/empty.test.js` });
  assert.equal(c.getRows().length, 0);
  assert.equal(c.dropped, 0);
});

test("a file whose tests fail normally does not also gain a file row, even if the runner emits a file-level fail", () => {
  const c = collector();
  start(c, "a failing test", 0);
  result(c, "a failing test", 0, 3, { kind: "fail" });
  // A runner that ALSO fails the file after its failed child: already represented.
  c.onStart({ name: FILE, nesting: 0 });
  c.onResult({ name: FILE, nesting: 0, file: FILE, line: 1, details: {} }, "fail");
  const rows = c.getRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.name, "a failing test");
});

test("a crash row is emitted beside the surviving file's rows, and only once per file", () => {
  const c = collector();
  fileEvent(c, CRASH_FILE, "fail");
  start(c, "survivor", 0);
  result(c, "survivor", 0, 2);
  fileEvent(c, CRASH_FILE, "fail");
  assert.deepEqual(
    c.getRows().map((r) => r.name),
    ["test/crash.test.js > (test file failed to run)", "survivor"],
  );
});

test("a file-level fail with no usable file is dropped and counted, never thrown", () => {
  const c = collector();
  c.onStart({ name: "x", nesting: 0 });
  c.onResult({ name: "x", nesting: 0, line: 1, details: {} }, "fail");
  assert.equal(c.getRows().length, 0);
  assert.equal(c.dropped, 1);
});

// --- A suite whose after()/before() hook fails ---------------------------

const HOOK_ROW = "test/alpha.test.js > (test file failed to run)";

function suiteResult(c: RunCollector, name: string, kind: "pass" | "fail", durationMs?: number, file: string = FILE): void {
  c.onResult(
    {
      name,
      nesting: 0,
      file,
      line: 1,
      details: { type: "suite", ...(durationMs === undefined ? {} : { duration_ms: durationMs }) },
    },
    kind,
  );
}

test("a failed suite whose children all passed (a throwing after() hook) ships ONE file row beside the children", () => {
  const c = collector();
  start(c, "teardown", 0);
  start(c, "still passes", 1);
  result(c, "still passes", 1, 5);
  suiteResult(c, "teardown", "fail", 12);
  const rows = c.getRows();
  assert.deepEqual(rows.map((r) => [r.name, r.outcome]), [
    ["teardown > still passes", "passed"],
    [HOOK_ROW, "failed"],
  ]);
  assert.equal(rows[1]!.line_number, 1);
  assert.equal(rows[1]!.duration, 0.012);
  assert.equal(c.dropped, 0);
});

test("a failed suite whose child also failed ships no extra row (the child IS the file's failed row)", () => {
  const c = collector();
  start(c, "both", 0);
  start(c, "fails itself", 1);
  result(c, "fails itself", 1, 5, { kind: "fail" });
  suiteResult(c, "both", "fail");
  assert.deepEqual(c.getRows().map((r) => r.name), ["both > fails itself"]);
});

test("a hook failure followed by a LATER failing test in the same file still ends with one failed row", () => {
  const c = collector();
  start(c, "teardown", 0);
  start(c, "still passes", 1);
  result(c, "still passes", 1, 5);
  suiteResult(c, "teardown", "fail");
  start(c, "later", 0);
  start(c, "fails itself", 1);
  result(c, "fails itself", 1, 9, { kind: "fail" });
  suiteResult(c, "later", "fail");
  assert.deepEqual(c.getRows().filter((r) => r.outcome === "failed").map((r) => r.name), ["later > fails itself"]);
});

test("two failed suites in one file ship ONE row; failed suites in two files ship one each", () => {
  const OTHER = "/repo/test/beta.test.js";
  const c = collector();
  start(c, "s1", 0);
  suiteResult(c, "s1", "fail");
  start(c, "s2", 0);
  suiteResult(c, "s2", "fail");
  start(c, "s3", 0);
  suiteResult(c, "s3", "fail", undefined, OTHER);
  assert.deepEqual(c.getRows().map((r) => r.name), [
    HOOK_ROW,
    "test/beta.test.js > (test file failed to run)",
  ]);
});

test("the hook row is byte-identical to the crash row for the same file, and getRows() is idempotent", () => {
  const hook = collector();
  start(hook, "teardown", 0);
  suiteResult(hook, "teardown", "fail");
  const crash = collector();
  fileEvent(crash, FILE, "fail", { file: FILE });
  assert.equal(hook.getRows()[0]!.name, crash.getRows()[0]!.name);
  assert.equal(hook.getRows()[0]!.id, crash.getRows()[0]!.id);
  assert.equal(hook.getRows().length, 1);
  assert.equal(hook.getRows().length, 1);
});

test("a hook failure then a file-level fail for the same file ships ONE row", () => {
  const c = collector();
  start(c, "teardown", 0);
  suiteResult(c, "teardown", "fail");
  fileEvent(c, FILE, "fail", { file: FILE });
  assert.equal(c.getRows().length, 1);
});

test("a passed suite adds nothing, and a failed suite with no usable file is ignored without throwing", () => {
  const c = collector();
  start(c, "ok", 0);
  suiteResult(c, "ok", "pass");
  c.onStart({ name: "nofile", nesting: 0 });
  c.onResult({ name: "nofile", nesting: 0, line: 1, details: { type: "suite" } }, "fail");
  assert.equal(c.getRows().length, 0);
  assert.equal(c.dropped, 0);
});
