import { test } from "node:test";
import assert from "node:assert/strict";
import { exampleOpenerLine, statementEndIndex } from "../src/node-test/example-opener.js";

// Pins the scanner members that example-opener.test.ts leaves unpinned: the
// `.` call-chain arm, template-text escapes, block comments, string-literal
// escapes and the `end >= rowLine - 1` boundary.

test("SPGD-2129: statementEndIndex follows a `.method(` chained after the closing `])`", () => {
  const src = ["it.each([", "  [1],", "]).skip(\"t\", () => {", "  body();", "});", "after();"];
  assert.equal(statementEndIndex(src, 0), 4);
});

test("SPGD-2129: statementEndIndex skips an escaped backtick inside tagged-template text", () => {
  const src = ["it.each`", "  a | b", "  ${1} | \\`", "`(\"t\", () => {});", "after();"];
  assert.equal(statementEndIndex(src, 0), 3);
});

test("SPGD-2129: statementEndIndex ignores brackets inside block comments, single- and multi-line", () => {
  const src = [
    "it.each([",
    "  /* ) */ [1],",
    "  /* ] ",
    "  ) */ [2],",
    "])(\"t\", () => {});",
    "after();",
  ];
  assert.equal(statementEndIndex(src, 0), 4);
});

test("SPGD-2129: statementEndIndex skips escaped quotes inside string literals", () => {
  const src = [
    "it.each([",
    '  ["a\\"b)", 1],',
    "  ['c\\'d]', 2],",
    '])("t", () => {});',
    "after();",
  ];
  assert.equal(statementEndIndex(src, 0), 3);
});

test("SPGD-2129: exampleOpenerLine resolves when the reported line is the statement's last line", () => {
  const src = ["it.each([", "  [1],", '])("t", fn);', "after();"];
  assert.equal(exampleOpenerLine(src, 3), 1);
});
