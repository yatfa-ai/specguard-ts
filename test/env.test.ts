import { test } from "node:test";
import assert from "node:assert/strict";
import { readRunnerEnv } from "../src/core/env.js";

function envWith(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

test("ci_run_id and shard_id are resolved from the documented provider list and stringified", () => {
  const e = readRunnerEnv({
    env: envWith({
      SPECGUARD_COMMIT_SHA: "abc",
      GITHUB_RUN_ID: "17442",
      CI_NODE_INDEX: "0",
    }),
  });
  assert.equal(e.ciRunId, "17442");
  assert.equal(e.shardId, "0");
});

test("GITHUB_RUN_ID is preferred for ci_run_id; a GITHUB_RUN_ATTEMPT rerun stays inside the same run id", () => {
  // Deliberate, documented decision: a "re-run all jobs" delivers inside the
  // same ci_run_id, so shards REPLACE their own numbers rather than double
  // the denominator (see README, "If you shard your suite").
  const e = readRunnerEnv({
    env: envWith({
      SPECGUARD_COMMIT_SHA: "abc",
      GITHUB_RUN_ID: "17442",
      GITHUB_RUN_ATTEMPT: "2",
    }),
  });
  assert.equal(e.ciRunId, "17442");
});

test("SPECGUARD_RUN_ID and SPECGUARD_SHARD_ID win over the provider variables", () => {
  const e = readRunnerEnv({
    env: envWith({
      SPECGUARD_COMMIT_SHA: "abc",
      SPECGUARD_RUN_ID: "custom-run",
      GITHUB_RUN_ID: "17442",
      SPECGUARD_SHARD_ID: "3",
      CI_NODE_INDEX: "0",
    }),
  });
  assert.equal(e.ciRunId, "custom-run");
  assert.equal(e.shardId, "3");
});

test("empty-string variables are treated as unset", () => {
  const e = readRunnerEnv({
    env: envWith({ SPECGUARD_COMMIT_SHA: "abc", GITHUB_RUN_ID: "" }),
  });
  assert.equal(e.ciRunId, null);
});

test("SPECGUARD_TIMEOUT is seconds; default is 10s; garbage falls back to 10s", () => {
  assert.equal(
    readRunnerEnv({ env: envWith({ SPECGUARD_COMMIT_SHA: "a", SPECGUARD_TIMEOUT: "2" }) }).timeoutMs,
    2000,
  );
  assert.equal(
    readRunnerEnv({ env: envWith({ SPECGUARD_COMMIT_SHA: "a" }) }).timeoutMs,
    10_000,
  );
  assert.equal(
    readRunnerEnv({ env: envWith({ SPECGUARD_COMMIT_SHA: "a", SPECGUARD_TIMEOUT: "soon" }) }).timeoutMs,
    10_000,
  );
});

test("output path defaults to log/test_results.jsonl", () => {
  assert.equal(
    readRunnerEnv({ env: envWith({ SPECGUARD_COMMIT_SHA: "a" }) }).outputPath,
    "log/test_results.jsonl",
  );
  assert.equal(
    readRunnerEnv({
      env: envWith({ SPECGUARD_COMMIT_SHA: "a", SPECGUARD_OUTPUT_PATH: "/tmp/x.jsonl" }),
    }).outputPath,
    "/tmp/x.jsonl",
  );
});
