// A describe-level afterAll that throws: its test PASSES, Vitest reports the
// file failed. The file loads and runs, so the crash-at-import discriminator
// (zero tests + module errors) never fires on it.
import { describe, test, afterAll } from "vitest";

describe("teardown", () => {
  afterAll(() => {
    throw new Error("afterAll boom");
  });
  test("still passes", () => {});
});
