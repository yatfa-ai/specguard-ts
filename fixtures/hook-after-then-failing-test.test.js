import { describe, it, after } from "node:test";

// The suite's after() hook fails FIRST (its suite closes before the second
// suite starts), then a later test in the SAME file fails on its own. The
// file must still end with exactly one failed row of its own, not two.
describe("teardown", () => {
  after(() => {
    throw new Error("after boom");
  });
  it("still passes", () => {});
});

describe("later", () => {
  it("fails itself", () => {
    throw new Error("test boom");
  });
});
