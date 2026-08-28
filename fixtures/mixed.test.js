import { test, describe } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

// Line numbers here are load-bearing: the integration test asserts
// line_number for each of these tests. If you move anything, update
// test/integration.node-test.test.js.

describe("passing suite", () => {
  test("child ok", async (t) => {
    await t.diagnostic("noise");
    await sleep(80);
  });

  describe("inner suite", () => {
    test("grandchild ok", () => {});
  });

  test("child failing", () => {
    throw new Error("deliberate failure");
  });

  test("child skipped", { skip: true }, () => {});
});
