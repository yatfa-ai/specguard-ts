// A top-level (module-level) afterAll that throws after a passing test.
import { test, afterAll } from "vitest";

afterAll(() => {
  throw new Error("top-level afterAll boom");
});

test("still passes", () => {});
