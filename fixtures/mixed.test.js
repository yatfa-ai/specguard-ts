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

  test("child skipped with reason", { skip: "flaky on CI" }, () => {});

  test("child skipped via t.skip", (t) => {
    t.skip("later");
  });

  test("child todo", { todo: true }, () => {});

  test("child todo with reason", { todo: "implement later" }, () => {});

  test("child todo throwing", { todo: "wip" }, () => {
    throw new Error("deliberate todo failure");
  });
});
