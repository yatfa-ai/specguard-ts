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
    skip?: boolean;
  } = {},
): void {
  collector.onResult(
    {
      name,
      nesting,
      file: FILE,
      line,
      skip: extra.skip === undefined ? undefined : extra.skip,
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
