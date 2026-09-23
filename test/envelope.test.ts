import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEnvelope } from "../src/core/envelope.js";
import { readRunnerEnv } from "../src/core/env.js";
import type { SpecRow } from "../src/core/types.js";

function row(name: string): SpecRow {
  return {
    file_path: "test/alpha.test.js",
    line_number: 3,
    status: "unannotated",
    intent: null,
    name,
    duration: 0.08,
    id: `id-${name}`,
    outcome: "passed",
  };
}

test("buildEnvelope emits ci_run_id and shard_id as JSON strings even when composed as numbers", () => {
  const envelope = buildEnvelope([row("works")], {
    // A shard index composed in code is a number — the exact trap. The
    // endpoint refuses a JSON number for either field.
    commitSha: "abc123",
    branch: "main",
    ciRunId: 17442 as unknown as string,
    shardId: 0 as unknown as string,
  }, 1.5);
  assert.ok(envelope !== null);
  const body = JSON.stringify(envelope);
  assert.ok(body.includes('"ci_run_id":"17442"'), body);
  assert.ok(body.includes('"shard_id":"0"'), body);
  assert.ok(!body.includes('"shard_id":0'), "shard_id leaked as a JSON number");
  assert.ok(!body.includes('"ci_run_id":17442'), "ci_run_id leaked as a JSON number");
});

test("buildEnvelope leaves ci_run_id and shard_id null when unresolved", () => {
  const envelope = buildEnvelope([], {
    commitSha: "abc123",
    branch: null,
    ciRunId: null,
    shardId: null,
  }, null);
  assert.ok(envelope !== null);
  const body = JSON.stringify(envelope);
  assert.ok(body.includes('"ci_run_id":null'));
  assert.ok(body.includes('"shard_id":null'));
  assert.ok(body.includes('"branch":null'));
  assert.ok(body.includes('"duration_seconds":null'));
});

test("buildEnvelope returns null without a commit sha — a payload without it would be refused", () => {
  assert.equal(
    buildEnvelope([row("works")], {
      commitSha: null,
      branch: null,
      ciRunId: null,
      shardId: null,
    }, 1),
    null,
  );
  assert.equal(
    buildEnvelope([row("works")], {
      commitSha: "",
      branch: null,
      ciRunId: null,
      shardId: null,
    }, 1),
    null,
  );
});

test("a whitespace-only commit sha reaches buildEnvelope as null and is dropped, end to end", () => {
  // Same rationale as the arm above, one character wider: the platform
  // requires `value.strip.present?`, so a blank sha is refused 400 exactly
  // as fully as an empty one — and the refused line is then re-posted
  // byte-for-byte from the replay queue forever.
  //
  // The guard in `envelope.ts` is UNCHANGED and is not what fixes this: it
  // still tests `=== ""`. What changed is upstream, in `firstEnv`, so the
  // blank never reaches here as a value. This asserts the end-to-end
  // property through the real resolver rather than hand-feeding "   " to
  // `buildEnvelope`, which would pin a guard this ticket deliberately did
  // not touch.
  const env = readRunnerEnv({
    env: { SPECGUARD_COMMIT_SHA: "   ", PATH: "/nonexistent" } as NodeJS.ProcessEnv,
  });
  assert.equal(env.commitSha, null, "the blank must resolve to null, not to whitespace");
  assert.equal(buildEnvelope([row("works")], env, 1), null);
});

test("negative or non-finite duration_seconds is nulled, never sent", () => {
  const envelope = buildEnvelope([], {
    commitSha: "abc123",
    branch: null,
    ciRunId: null,
    shardId: null,
  }, -5);
  assert.ok(envelope !== null);
  assert.equal(envelope.duration_seconds, null);
});

test("the envelope shape matches the wire contract field-for-field", () => {
  const envelope = buildEnvelope([row("works")], {
    commitSha: "abc123",
    branch: "main",
    ciRunId: "17",
    shardId: "0",
  }, 2.5);
  assert.ok(envelope !== null);
  assert.deepEqual(Object.keys(envelope).sort(), [
    "branch",
    "ci_run_id",
    "commit_sha",
    "duration_seconds",
    "shard_id",
    "specs",
  ]);
  assert.deepEqual(
    Object.keys(envelope.specs[0] as SpecRow).sort(),
    [
      "duration",
      "file_path",
      "id",
      "intent",
      "line_number",
      "name",
      "outcome",
      "status",
    ],
  );
});
