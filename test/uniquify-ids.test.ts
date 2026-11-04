import { test } from "node:test";
import assert from "node:assert/strict";
import { exampleId, uniquifyIds, uniquifyRows } from "../src/core/id.js";
import type { SpecRow } from "../src/core/types.js";

function row(file: string, name: string, line: number, outcome = "passed"): SpecRow {
  return {
    file_path: file,
    line_number: line,
    status: "unannotated",
    intent: null,
    name,
    duration: 0.01,
    id: exampleId(file, name),
    outcome,
  };
}

const repeated = (): SpecRow[] => [
  row("a.test.js", "calc > adds", 5),
  row("a.test.js", "calc > adds", 5, "failed"),
  row("a.test.js", "calc > adds", 5),
];

test("three same-name rows in one file get three distinct ids", () => {
  const { rows } = uniquifyIds(repeated());
  assert.equal(new Set(rows.map((r) => r.id)).size, 3);
});

test("ids are identical on a second run over the same rows", () => {
  assert.deepEqual(
    uniquifyIds(repeated()).rows.map((r) => r.id),
    uniquifyIds(repeated()).rows.map((r) => r.id),
  );
});

test("every member of a colliding group takes the suffix, the first included", () => {
  const { rows } = uniquifyIds(repeated());
  for (const r of rows) assert.notEqual(r.id, exampleId("a.test.js", "calc > adds"));
});

test("adding a duplicate does not change which id the first row had relative to a later pair", () => {
  // The k-th member's id depends only on (path, name, k): a fourth repeat
  // appended at the end leaves the first three ids untouched.
  const three = uniquifyIds(repeated()).rows.map((r) => r.id);
  const four = uniquifyIds([...repeated(), row("a.test.js", "calc > adds", 5)]).rows.map((r) => r.id);
  assert.deepEqual(four.slice(0, 3), three);
});

test("non-colliding rows keep their id byte for byte, beside a colliding group", () => {
  const solo = row("a.test.js", "calc > distinct", 9);
  const other = row("b.test.js", "calc > adds", 5); // same name, other file
  const { rows, disambiguated } = uniquifyIds([repeated()[0]!, solo, repeated()[1]!, other]);
  assert.equal(rows[1]!.id, exampleId("a.test.js", "calc > distinct"));
  assert.equal(rows[3]!.id, exampleId("b.test.js", "calc > adds"));
  assert.deepEqual([...disambiguated], [["a.test.js", 2]]);
});

test("ordinals follow input order, so the row order is preserved and stable", () => {
  const input = repeated();
  const { rows } = uniquifyIds(input);
  assert.deepEqual(rows.map((r) => r.outcome), ["passed", "failed", "passed"]);
  assert.equal(rows[0]!.id, uniquifyIds([input[0]!, input[1]!]).rows[0]!.id);
});

test("only id changes: name, outcome and the rest pass through; input is not mutated", () => {
  const input = repeated();
  const before = JSON.stringify(input);
  const { rows } = uniquifyIds(input);
  assert.equal(JSON.stringify(input), before);
  rows.forEach((r, i) => assert.deepEqual({ ...r, id: "" }, { ...input[i]!, id: "" }));
  assert.equal(rows[1]!.outcome, "failed");
  assert.equal(rows[1]!.name, "calc > adds");
});

test("no collisions: the same rows come back and nothing is reported", () => {
  const input = [row("a.test.js", "x", 1), row("a.test.js", "y", 2)];
  const { rows, disambiguated } = uniquifyIds(input);
  assert.deepEqual(rows, input);
  assert.equal(disambiguated.size, 0);
});

/** Run `fn` with `process.stderr.write` captured; always restore it. */
function captureStderr<T>(fn: () => T): { result: T; writes: string[] } {
  const writes: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: fn(), writes };
  } finally {
    process.stderr.write = original;
  }
}

/** `count` rows sharing one file and name, so each file contributes `count` disambiguated rows. */
const collidingFile = (file: string, count: number): SpecRow[] =>
  Array.from({ length: count }, () => row(file, "dup", 1));

const collidingFiles = (files: number, perFile: number): SpecRow[] =>
  Array.from({ length: files }, (_, i) => collidingFile(`f${i + 1}.test.js`, perFile)).flat();

test("uniquifyRows: one stderr line names every colliding file and totals the rows across them", () => {
  const { result, writes } = captureStderr(() =>
    uniquifyRows([...collidingFile("a.test.js", 2), ...collidingFile("b.test.js", 3)]),
  );
  assert.equal(result.length, 5);
  assert.equal(new Set(result.map((r) => r.id)).size, 5);
  assert.equal(writes.length, 1);
  const line = writes[0] ?? "";
  assert.match(line, /disambiguated 5 test\(s\)/);
  assert.ok(line.includes("a.test.js (2), b.test.js (3)"), line);
});

test("uniquifyRows: names five colliding files and adds no summary at exactly the cap", () => {
  const { writes } = captureStderr(() => uniquifyRows(collidingFiles(5, 2)));
  assert.equal(writes.length, 1);
  const line = writes[0] ?? "";
  assert.match(line, /disambiguated 10 test\(s\)/);
  assert.ok(
    line.includes("f1.test.js (2), f2.test.js (2), f3.test.js (2), f4.test.js (2), f5.test.js (2)"),
    line,
  );
  assert.ok(!line.includes("more file(s)"), line);
});

test("uniquifyRows: summarises the files past the cap and does not name them", () => {
  const { writes } = captureStderr(() => uniquifyRows(collidingFiles(6, 2)));
  assert.equal(writes.length, 1);
  const line = writes[0] ?? "";
  assert.match(line, /disambiguated 12 test\(s\)/);
  assert.ok(line.includes("f5.test.js (2), and 1 more file(s)."), line);
  assert.ok(!line.includes("f6.test.js"), line);
});

test("uniquifyRows: says nothing and ships the rows unchanged when nothing collides", () => {
  const input = [row("a.test.js", "one", 1), row("a.test.js", "two", 2), row("b.test.js", "one", 1)];
  const { result, writes } = captureStderr(() => uniquifyRows(input));
  assert.deepEqual(writes, []);
  assert.deepEqual(result, input);
});

test("uniquifyRows: ships the rows unchanged, silently, when disambiguation throws", () => {
  const input = [row("a.test.js", "one", 1), null as never];
  const { result, writes } = captureStderr(() => uniquifyRows(input));
  assert.equal(result.length, 2);
  assert.equal(result[0], input[0]);
  assert.equal(result[1], input[1]);
  assert.deepEqual(writes, []);
});
