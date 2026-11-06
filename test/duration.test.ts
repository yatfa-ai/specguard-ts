import { test } from "node:test";
import assert from "node:assert/strict";
import { msToSeconds } from "../src/core/duration.js";

test("msToSeconds converts milliseconds to seconds and keeps 0 as 0", () => {
  assert.equal(msToSeconds(1500), 1.5);
  assert.equal(msToSeconds(80), 0.08);
  assert.equal(msToSeconds(0), 0);
});

test("msToSeconds ships null for a missing or unusable duration", () => {
  for (const bad of [null, undefined, "12", NaN, Infinity, -Infinity, -1, {}]) {
    assert.equal(msToSeconds(bad), null, String(bad));
  }
});
