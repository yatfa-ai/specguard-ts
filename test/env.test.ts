import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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

test("whitespace-only variables are treated as unset, for every key the reader gates", () => {
  // The same property one character wider than the empty-string arm above,
  // and the port of Ruby's `Configuration#first_present`, which does
  // `env[key].to_s.strip` and skips the key when the result is empty.
  //
  // The key that motivated it is `commitSha`: a blank one passed the old
  // `!== ""` predicate, passed `buildEnvelope`'s `=== ""` guard, and was
  // refused 400 by the platform, which requires `value.strip.present?` —
  // and the saved fallback line is re-posted byte-for-byte, so the run was
  // lost behind a queue entry that looked recoverable. The fix is in the
  // shared predicate, so the property is asserted for every key it gates,
  // not for `commitSha` alone.
  //
  // No git fallback can rescue `commitSha` or `branch` here: the fixture
  // env carries no PWD and the assertions run wherever the suite runs, so
  // both are pinned in the dedicated non-git block below instead.
  for (const blank of ["   ", "\t", "\n", " \t\n "]) {
    const e = readRunnerEnv({
      env: envWith({
        SPECGUARD_COMMIT_SHA: "abc",
        GITHUB_RUN_ID: blank,
        CI_NODE_INDEX: blank,
        SPECGUARD_ENDPOINT: blank,
        SPECGUARD_API_KEY: blank,
        SPECGUARD_TIMEOUT: blank,
        SPECGUARD_OUTPUT_PATH: blank,
        SPECGUARD_LOCAL_OUTPUT_PATH: blank,
      }),
    });
    const shown = JSON.stringify(blank);
    assert.equal(e.ciRunId, null, `GITHUB_RUN_ID ${shown} must be unset`);
    assert.equal(e.shardId, null, `CI_NODE_INDEX ${shown} must be unset`);
    assert.equal(e.endpoint, null, `SPECGUARD_ENDPOINT ${shown} must be unset`);
    assert.equal(e.apiKey, null, `SPECGUARD_API_KEY ${shown} must be unset`);
    // Unset, so each of these falls back to its own default rather than
    // carrying the blank through: a blank timeout is not 0ms, and a blank
    // path is not a run written to "".
    assert.equal(e.timeoutMs, 10_000, `SPECGUARD_TIMEOUT ${shown} must be unset`);
    assert.equal(
      e.outputPath,
      "log/test_results.jsonl",
      `SPECGUARD_OUTPUT_PATH ${shown} must be unset`,
    );
    assert.equal(
      e.localOutputPath,
      "log/test_results.local.jsonl",
      `SPECGUARD_LOCAL_OUTPUT_PATH ${shown} must be unset`,
    );
  }
});

test("a value padded with whitespace resolves to its trimmed content", () => {
  // The trim applies to the RETURNED value, not only to the emptiness test.
  // Not a behaviour change that needs its own argument: the platform stores
  // `@body["commit_sha"].strip`, so a padded sha keyed the same run either
  // way — Ruby already trimmed it, and this is the twin catching up.
  const e = readRunnerEnv({
    env: envWith({
      SPECGUARD_COMMIT_SHA: "  abc123\n",
      SPECGUARD_BRANCH: "\tmain ",
      GITHUB_RUN_ID: " 17442 ",
      CI_NODE_INDEX: " 0 ",
      SPECGUARD_ENDPOINT: " https://example.test/api/v1/ingest ",
      SPECGUARD_API_KEY: " sg_live_key ",
      SPECGUARD_TIMEOUT: " 2 ",
      SPECGUARD_OUTPUT_PATH: " /tmp/queue.jsonl ",
      SPECGUARD_LOCAL_OUTPUT_PATH: " /tmp/local.jsonl ",
    }),
  });
  assert.equal(e.commitSha, "abc123");
  assert.equal(e.branch, "main");
  assert.equal(e.ciRunId, "17442");
  assert.equal(e.shardId, "0");
  assert.equal(e.endpoint, "https://example.test/api/v1/ingest");
  assert.equal(e.apiKey, "sg_live_key");
  assert.equal(e.timeoutMs, 2000);
  assert.equal(e.outputPath, "/tmp/queue.jsonl");
  assert.equal(e.localOutputPath, "/tmp/local.jsonl");
});

test("each provider branch variable resolves through readRunnerEnv", () => {
  // The full list this client reads — the Ruby client's BRANCH_KEYS plus
  // CI_COMMIT_BRANCH: a superset, never equality, and grown in step whenever
  // the Ruby list gains a key — so a TS suite on CircleCI, Buildkite,
  // Jenkins or a GitLab merge-request pipeline keeps its branch attribution
  // even though those providers check out in DETACHED HEAD and the
  // `git branch --show-current` fallback returns empty there.
  for (const [name, value] of [
    ["SPECGUARD_BRANCH", "feature/local"],
    ["GITHUB_REF_NAME", "feature/github"],
    ["CI_COMMIT_REF_NAME", "feature/gitlab-mr"],
    ["CI_COMMIT_BRANCH", "feature/gitlab-branch"],
    ["CIRCLE_BRANCH", "feature/circleci"],
    ["BUILDKITE_BRANCH", "feature/buildkite"],
    ["GIT_BRANCH", "origin/feature/jenkins"],
  ] as const) {
    const e = readRunnerEnv({
      env: envWith({ SPECGUARD_COMMIT_SHA: "abc", [name]: value }),
    });
    assert.equal(e.branch, value, `${name} must resolve for branch`);
  }
});

test("SPECGUARD_BRANCH wins over the provider branch variables", () => {
  const e = readRunnerEnv({
    env: envWith({
      SPECGUARD_COMMIT_SHA: "abc",
      SPECGUARD_BRANCH: "mine",
      GITHUB_REF_NAME: "theirs",
      CIRCLE_BRANCH: "also-theirs",
    }),
  });
  assert.equal(e.branch, "mine");
});

test("CI_COMMIT_REF_NAME resolves before CI_COMMIT_BRANCH", () => {
  // GitLab sets CI_COMMIT_REF_NAME on merge-request pipelines, where
  // CI_COMMIT_BRANCH is unset; on branch pipelines both carry the branch.
  // The ref name is first so an MR pipeline keeps its branch either way.
  const e = readRunnerEnv({
    env: envWith({
      SPECGUARD_COMMIT_SHA: "abc",
      CI_COMMIT_REF_NAME: "feature/mr",
      CI_COMMIT_BRANCH: "feature/branch",
    }),
  });
  assert.equal(e.branch, "feature/mr");
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

test("local output path defaults to log/test_results.local.jsonl and is overridden independently of the replay queue", () => {
  // Two sinks, two knobs: the keyless local-development record and the
  // failed-delivery replay queue are separate files by design, so each has
  // its own variable and its own default, and neither names the other's.
  const plain = readRunnerEnv({ env: envWith({ SPECGUARD_COMMIT_SHA: "a" }) });
  assert.equal(plain.outputPath, "log/test_results.jsonl");
  assert.equal(plain.localOutputPath, "log/test_results.local.jsonl");

  const overridden = readRunnerEnv({
    env: envWith({
      SPECGUARD_COMMIT_SHA: "a",
      SPECGUARD_LOCAL_OUTPUT_PATH: "/tmp/local.jsonl",
      SPECGUARD_OUTPUT_PATH: "/tmp/queue.jsonl",
    }),
  });
  assert.equal(overridden.localOutputPath, "/tmp/local.jsonl");
  assert.equal(overridden.outputPath, "/tmp/queue.jsonl");
});

// --- SPGD-1403: the shadowing case ------------------------------------------
//
// The deliberate decision: PIN IT, with a real git fixture rather than a
// stubbed probe. It is the shape with the largest loss in this defect — a
// valid sha resolved and then discarded — and it is structurally invisible
// in the non-git arms above, because the fallback cannot fire there: those
// arms prove the blank is not ADMITTED, and only this one proves the good
// sha is REACHED. A stubbed `git` was rejected as the cheaper option: the
// probe is `execFileSync("git", ...)` with no cwd, so stubbing it means
// putting a fake `git` first on PATH and asserting against a string the
// test itself authored — which would pass with the fallback wired to
// anything at all. The fixture costs one `git init` and asserts against
// what `git rev-parse HEAD` actually returns.
//
// The probe runs in `process.cwd()`, so the fixture is entered with chdir
// and restored in `finally`, the same shape `test/lint.test.ts` uses for
// its own git fixtures.

test("a whitespace-only SPECGUARD_COMMIT_SHA no longer shadows the git fallback", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "specguard-env-git-"));
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "specguard-test@example.com");
  git("config", "user.name", "specguard-test");
  git("commit", "-q", "--allow-empty", "-m", "base");
  const head = git("rev-parse", "HEAD").trim();
  assert.match(head, /^[0-9a-f]{40}$/, "fixture must have a real HEAD to fall back to");

  const previous = process.cwd();
  process.chdir(root);
  try {
    // Control: with no commit key set at all, the fallback resolves.
    assert.equal(readRunnerEnv({ env: envWith({}) }).commitSha, head);

    // The defect: the blank used to win this race and the good sha was
    // thrown away, so the run was delivered with commit_sha "   ", refused
    // 400, and queued as a line that can never be replayed.
    for (const blank of ["   ", "\t\n"]) {
      assert.equal(
        readRunnerEnv({ env: envWith({ SPECGUARD_COMMIT_SHA: blank }) }).commitSha,
        head,
        `SPECGUARD_COMMIT_SHA ${JSON.stringify(blank)} must not shadow the git fallback`,
      );
    }

    // The branch key shares the predicate and the fallback, so it shares
    // the property: a blank must not shadow `git branch --show-current`.
    assert.equal(readRunnerEnv({ env: envWith({ SPECGUARD_BRANCH: "  " }) }).branch, "main");
  } finally {
    process.chdir(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
