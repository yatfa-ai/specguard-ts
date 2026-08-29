import { test } from "node:test";

// Line numbers here are load-bearing: test/annotate.test.ts and
// test/integration.node-test.test.ts assert (file, line) mapping, including
// the comment-above-`test(` offset. If you move anything, update those tests.

// @intent: {"entity":"Cart","action":"apply promo code","behavior":"applies the discount when the code is valid","layer":"unit"}
test("applies a valid promo code", () => {});

// @intent: {"entity":"Cart","action":"apply promo code","behavior":"rejects an expired code with a user-facing error","layer":"unit"}
test("rejects an expired promo code", () => {});

test("has no annotation above it", () => {});
