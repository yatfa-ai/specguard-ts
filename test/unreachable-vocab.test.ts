import { test } from "node:test";
import assert from "node:assert/strict";

import {
  stackedFindingsInText,
  separatedFindingsInText,
  ownLineShadowFindingsInText,
  groupLineFindingsInText,
  unreachableFindings,
} from "../src/lint/unreachable.js";

// SPGD-1568: the example-call vocabulary is ONE rule shared by the three
// example-anchored arms and the group arm's one-liner exemption. Each case
// below is driven per-arm over the whole call list, comparing against the
// plain `it(` fixture's finding (same message, same line) so a widened rule
// cannot change what a finding says — only whether the shape is recognised.

const PAYLOAD = '{"entity":"Cart","action":"add","behavior":"increments quantity","layer":"unit"}';
const A = `// @intent: ${PAYLOAD}`;
const B = `// @intent: ${PAYLOAD.replace("increments quantity", "clears the cart")}`;

/** `<head>` is the call text up to (not including) the call's own `(`. */
const CALLS: string[] = [
  "it.concurrent",
  "it.each([1])",
  "test.each`a|b`",
  "it.skipIf(true)",
  "it.runIf(1)",
  "it.fails",
  "it.sequential",
  "it.for([1])",
  "it.skip.each([1])",
  "test.concurrent.only",
  "xit",
  "fit",
  "xtest",
];
const PLAIN = "it";
const callLine = (head: string, tail = "") => `${head}("a", () => {});${tail}`;

function run(arm: (t: string, f: string) => ReturnType<typeof stackedFindingsInText>, text: string) {
  return arm(text, "f.test.js");
}

for (const head of [PLAIN, ...CALLS]) {
  test(`stacked arm anchors on ${head}(`, () => {
    const text = [A, B, callLine(head), ""].join("\n");
    const plain = run(stackedFindingsInText, [A, B, callLine(PLAIN), ""].join("\n"));
    assert.equal(plain.length, 1);
    const got = run(stackedFindingsInText, text);
    assert.deepEqual(got, plain);
  });

  test(`separated arm anchors on ${head}(`, () => {
    const plainText = [A, "", callLine(PLAIN), ""].join("\n");
    const plain = run(separatedFindingsInText, plainText);
    assert.equal(plain.length, 1);
    assert.deepEqual(run(separatedFindingsInText, [A, "", callLine(head), ""].join("\n")), plain);
    // an ordinary comment interleave reads the same
    assert.deepEqual(
      run(separatedFindingsInText, [A, "// note", callLine(head), ""].join("\n")),
      run(separatedFindingsInText, [A, "// note", callLine(PLAIN), ""].join("\n")),
    );
  });

  test(`own-line-shadow arm anchors on ${head}(`, () => {
    const own = ` // @intent: ${PAYLOAD}`;
    const plain = run(ownLineShadowFindingsInText, [A, callLine(PLAIN, own), ""].join("\n"));
    assert.equal(plain.length, 1);
    assert.deepEqual(run(ownLineShadowFindingsInText, [A, callLine(head, own), ""].join("\n")), plain);
  });

  test(`group arm one-liner exemption holds for ${head}(`, () => {
    const line = `describe("g", () => { ${callLine(head, ` // @intent: ${PAYLOAD}`)}`;
    assert.deepEqual(run(groupLineFindingsInText, line + "\n"), []);
  });

  test(`the four arms stay disjoint on ${head}( — no line flagged twice`, () => {
    const own = ` // @intent: ${PAYLOAD}`;
    const text = [A, B, callLine(head, own), "", A, "", callLine(head), ""].join("\n");
    const all = [
      ...stackedFindingsInText(text, "f"),
      ...separatedFindingsInText(text, "f"),
      ...ownLineShadowFindingsInText(text, "f"),
      ...groupLineFindingsInText(text, "f"),
    ].map((x) => x.line);
    assert.equal(new Set(all).size, all.length, `double-flagged: ${all}`);
    assert.deepEqual([...all].sort((x, y) => (x ?? 0) - (y ?? 0)), [1, 2, 5]);
  });
}

test("a multi-line `test.each` table opening (template open at end of line) anchors", () => {
  const text = [A, B, "test.each`", "  a | b", "`(\"x\", () => {});", ""].join("\n");
  assert.equal(stackedFindingsInText(text, "f").length, 1);
});

test("group lines still flag: describe.each / describe.skipIf / describe.concurrent trailing @intent", () => {
  for (const head of ["describe.each([1])", "describe.skipIf(1)", "describe.concurrent", "describe", "suite", "context"]) {
    const found = groupLineFindingsInText(`${head}("g", () => { // @intent: ${PAYLOAD}\n`, "f");
    assert.equal(found.length, 1, head);
    assert.equal(found[0]!.line, 1);
  }
});

test("describe/suite/context are never example heads for the anchored arms", () => {
  for (const head of ["describe", "suite", "context", "describe.each([1])"]) {
    const text = [A, B, `${head}("g", () => {});`, ""].join("\n");
    assert.deepEqual(stackedFindingsInText(text, "f"), [], head);
  }
});

// Negative controls: none of these opens an example, so none anchors an arm.
const NEGATIVES = [
  'item("a");',
  'testing("x");',
  'itinerary("x");',
  'specifying("x");',
  'fitness("x");',
  'xitem("x");',
  '// it("x")',
  '"it.each(" + x',
  "const s = 'it.each(';",
  "it;",
];

for (const neg of NEGATIVES) {
  test(`negative control does not anchor any arm: ${neg}`, () => {
    const own = ` // @intent: ${PAYLOAD}`;
    assert.deepEqual(stackedFindingsInText([A, B, neg, ""].join("\n"), "f"), [], "stacked");
    assert.deepEqual(separatedFindingsInText([A, "", neg, ""].join("\n"), "f"), [], "separated");
    assert.deepEqual(ownLineShadowFindingsInText([A, neg + own, ""].join("\n"), "f"), [], "shadow");
  });
}

test("negative controls do not exempt a group line either", () => {
  for (const neg of ['item("a");', 'testing("x");', 'itinerary("x");', 'fitness("x");']) {
    const found = groupLineFindingsInText(`describe("g", () => { ${neg} // @intent: ${PAYLOAD}\n`, "f");
    assert.equal(found.length, 1, neg);
  }
});

test("unreachableFindings export is unaffected by an unreadable file", () => {
  assert.deepEqual(unreachableFindings(["/nonexistent/path.test.js"]), []);
});
