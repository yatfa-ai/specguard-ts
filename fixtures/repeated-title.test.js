import { describe, test } from "node:test";
import assert from "node:assert/strict";

describe("calc", () => {
  for (const n of [1, 2, 3]) {
    test("adds", () => {
      assert.notEqual(n, 2);
    });
  }
  test("distinct title", () => {});
});
