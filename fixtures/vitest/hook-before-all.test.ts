// A describe-level beforeAll that throws: Vitest reports its test as
// skipped (shipped "pending") while the file and the run are failed.
import { describe, test, beforeAll } from "vitest";

describe("setup", () => {
  beforeAll(() => {
    throw new Error("beforeAll boom");
  });
  test("never runs", () => {});
});
