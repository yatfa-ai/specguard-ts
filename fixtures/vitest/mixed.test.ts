import { test, describe, expect } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";

// Line numbers here are load-bearing: test/integration.vitest.test.ts asserts
// line_number for each of these tests (and the coordinates fixture asserts
// the anchor of `location.line`). If you move anything, update that test.

describe("passing suite", () => {
  test("child ok", async () => {
    await sleep(80);
    expect(true).toBe(true);
  });

  describe("inner suite", () => {
    test("grandchild ok", () => {
      expect(true).toBe(true);
    });
  });

  test("child failing", () => {
    expect(1).toBe(2);
  });

  test.skip("child skipped", () => {});

  test.todo("child todo");
});

test("top level ok", () => {
  expect(true).toBe(true);
});
