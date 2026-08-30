import { test, expect } from "vitest";

// Line numbers here are load-bearing: test/integration.vitest.test.ts asserts
// (file, line) mapping through the annotation pass, including the
// comment-above-`test(` offset. If you move anything, update that test.

// @intent: {"entity":"Cart","action":"apply promo code","behavior":"applies the discount when the code is valid","layer":"unit"}
test("applies a valid promo code", () => {
  expect(true).toBe(true);
});

// @intent: {"entity":"Cart","action":"apply promo code","behavior":"rejects an expired code with a user-facing error","layer":"unit"}
test("rejects an expired promo code", () => {
  expect(true).toBe(true);
});

test("has no annotation above it", () => {
  expect(true).toBe(true);
});
