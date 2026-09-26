import { test } from "node:test";

// Line numbers here are load-bearing: test/annotate.test.ts pins the
// SAME-LINE annotation forms (SPGD-1519) against these lines via
// lineOfSameLine(). This file is read as source text by the comment-only
// gate — it is never executed. If you move anything, update those tests.

test("adjacent a", () => {}); // @intent: {"entity":"Cart","action":"apply promo code","behavior":"adjacent first one-liner keeps its own intent","layer":"unit"}
test("adjacent b", () => {}); // @intent: {"entity":"Cart","action":"apply promo code","behavior":"adjacent second one-liner keeps its own intent","layer":"unit"}

test("lone trailing", () => {}); // @intent: {"entity":"Cart","action":"apply promo code","behavior":"lone trailing one-liner ships its own payload","layer":"unit"}

// @intent: {"entity":"Cart","action":"apply promo code","behavior":"the comment above must lose to the own line","layer":"unit"}
test("own above both", () => {}); // @intent: {"entity":"Cart","action":"apply promo code","behavior":"own line beats the comment directly above it","layer":"unit"}
test("below claims nothing", () => {});