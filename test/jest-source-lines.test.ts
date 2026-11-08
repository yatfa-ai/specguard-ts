import { test } from "node:test";
import assert from "node:assert/strict";

import { scanTestCalls, SourceLineIndex } from "../src/jest/source-lines.js";

/** `[title, line]` pairs, the shape every example below asserts. */
function pairs(source: string): Array<[string, number]> {
  return scanTestCalls(source).map(({ title, line }) => [title, line]);
}

test("scanTestCalls decodes escaped quotes, apostrophes and \\t/\\n in a literal title", () => {
  const source = [
    'it("say \\"hi\\"", () => {});',
    "it('it\\'s fine', () => {});",
    'it("a\\tb\\nc", () => {});',
  ].join("\n");
  assert.deepEqual(pairs(source), [
    ['say "hi"', 1],
    ["it's fine", 2],
    ["a\tb\nc", 3],
  ]);
});

test("scanTestCalls returns a backtick title at its call line and skips an interpolated one", () => {
  const source = [
    "it(`plain title`, () => {});",
    "it(`multi",
    "line`, () => {});",
    "it(`value ${x}`, () => {});",
  ].join("\n");
  assert.deepEqual(pairs(source), [
    ["plain title", 1],
    ["multi\nline", 2],
  ]);
});

test("scanTestCalls ignores helper and member calls that merely end in it/test", () => {
  const source = [
    'subtest("first", () => {});',
    'helpers.it("first", () => {});',
    'benefit("first", () => {});',
    'it("first", () => {});',
  ].join("\n");
  assert.deepEqual(pairs(source), [["first", 4]]);
});

test("scanTestCalls matches fit, xit and xtest literals with their lines", () => {
  const source = [
    'fit("focused", () => {});',
    'xit("skipped it", () => {});',
    'xtest("skipped test", () => {});',
  ].join("\n");
  assert.deepEqual(pairs(source), [
    ["focused", 1],
    ["skipped it", 2],
    ["skipped test", 3],
  ]);
});

test("SourceLineIndex.take hands out successive lines for a repeated title, then null", () => {
  const index = new SourceLineIndex(['it("dup", () => {});', "", 'it("dup", () => {});'].join("\n"));
  assert.equal(index.take("dup"), 1);
  assert.equal(index.take("dup"), 3);
  assert.equal(index.take("dup"), null);
  assert.equal(index.take("never written"), null);
});

test("SourceLineIndex.takePosition hands out the 1-based call column beside the line", () => {
  const index = new SourceLineIndex(['describe("d", () => {', '  it("inner", () => {});', "});"].join("\n"));
  assert.deepEqual(index.takePosition("inner"), { title: "inner", line: 2, column: 3 });
  assert.equal(index.takePosition("absent"), null);
});
