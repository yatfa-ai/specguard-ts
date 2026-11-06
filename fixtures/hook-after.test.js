import { describe, it, after } from "node:test";

// A describe-level after() hook that throws: the child test PASSES, the
// runner reports the SUITE failed (test:fail, details.type "suite") and the
// run exits 1. No test row fails, so the reporter must add the file's row.
describe("teardown", () => {
  after(() => {
    throw new Error("after boom");
  });
  it("still passes", () => {});
});
