import { test } from "node:test";
import assert from "node:assert/strict";
import { exampleOpenerLine, statementEndIndex } from "../src/node-test/example-opener.js";

const lines = (text: string): string[] => text.split("\n");

test("SPGD-2117: statementEndIndex follows a multi-line array each to the end of its SECOND call", () => {
  const src = lines('it.each([\n  [1, "a)"],\n  [2, \'b]\'], // ) ]\n])("t %i", (n) => {\n  expect(n).toBe(n);\n});\nit("next", () => {});');
  assert.equal(statementEndIndex(src, 0), 5);
});

test("SPGD-2117: statementEndIndex follows a tagged-template table, `${}` nesting included", () => {
  const src = lines("it.each`\n  a | b\n  ${{ x: `n${1}` }} | ${2}\n`(\"t\", () => {});\nafter();");
  assert.equal(statementEndIndex(src, 0), 3);
});

test("SPGD-2117: statementEndIndex answers null for text that does not balance", () => {
  assert.equal(statementEndIndex(lines("it.each([\n  [1],\n)(\"t\", f)"), 0), null);
  assert.equal(statementEndIndex(lines("it.each([\n  [1],"), 0), null);
});

test("SPGD-2117: exampleOpenerLine resolves the opener from the closing line", () => {
  const src = lines('// c\nit.each([\n  [1],\n])("t", () => {\n  body();\n});');
  assert.equal(exampleOpenerLine(src, 4), 2);
});

test("SPGD-2117: exampleOpenerLine is null when the line is itself an example head, or nothing opens it", () => {
  const src = lines('it("plain", () => {\n  x();\n});\nconst y = 1;');
  assert.equal(exampleOpenerLine(src, 1), null);
  assert.equal(exampleOpenerLine(src, 4), null); // the earlier head's extent ends at line 3
  assert.equal(exampleOpenerLine(src, 0), null);
  assert.equal(exampleOpenerLine(src, 99), null);
});

test("SPGD-2117: exampleOpenerLine ignores an unrelated head whose extent does not reach the line", () => {
  const src = lines('it.each([[1]])("a", () => {});\n\nsomething(\n  1,\n);');
  assert.equal(exampleOpenerLine(src, 4), null);
});
