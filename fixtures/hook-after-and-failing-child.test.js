import { describe, it, after } from "node:test";

// The child fails AND the suite fails (its after() throws, and a failing
// child already fails the suite): the child's own failed row represents the
// file, so no file row may be added beside it.
describe("both", () => {
  after(() => {
    throw new Error("after boom");
  });
  it("fails itself", () => {
    throw new Error("test boom");
  });
});
