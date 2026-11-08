// Line numbers here are load-bearing: test/integration.jest.test.ts asserts
// which rows the annotation pass attributes to which `@intent`. Jest reports a
// multi-line `it.each` at the line of its closing `])("title", fn)` (array
// form) / `` `("title", fn) `` (tagged form) call, not the line `it.each`
// opens on, so the annotation sits several lines away from the row. If you
// move anything, update that test.

// @intent: {"entity":"Cart","action":"price lines","behavior":"prices every array-form row","layer":"unit"}
it.each([
  [1, 2],
  [3, 4],
])("array form %i", (a, b) => {
  expect(a).toBeLessThan(b);
});

// @intent: {"entity":"Cart","action":"price lines","behavior":"prices every tagged-template row","layer":"unit"}
it.each`
  a    | b
  ${1} | ${2}
  ${3} | ${4}
`("tagged form $a", ({ a, b }) => {
  expect(a).toBeLessThan(b);
});

it.each([ // @intent: {"entity":"Cart","action":"price lines","behavior":"prices a trailing-annotated opener","layer":"unit"}
  [5, 6],
])("trailing form %i", (a, b) => {
  expect(a).toBeLessThan(b);
});

it.each([
  [7, 8],
])("unannotated after annotated %i", (a, b) => {
  expect(a).toBeLessThan(b);
});
