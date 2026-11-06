// A file whose test fails AND whose afterAll throws: the failing test is
// already the file's failed row, so no file row may be added beside it.
import { describe, test, afterAll } from "vitest";

describe("both", () => {
  afterAll(() => {
    throw new Error("afterAll boom");
  });
  test("fails itself", () => {
    throw new Error("test boom");
  });
});
