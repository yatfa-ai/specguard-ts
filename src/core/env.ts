import { execFileSync } from "node:child_process";

export interface RunnerEnv {
  commitSha: string | null;
  branch: string | null;
  ciRunId: string | null;
  shardId: string | null;
  endpoint: string | null;
  apiKey: string | null;
  /**
   * The repository an `sga_` agent key delivers to (`SPECGUARD_REPOSITORY_ID`).
   * An agent key covers a SET of repositories and cannot name one itself, so the
   * platform accepts it only at `POST /api/v1/repositories/:id/ingest`. `null`
   * (unset or blank) keeps the bare `/api/v1/ingest` path, which is what an
   * `sgk_` repository key uses.
   */
  repositoryId: string | null;
  /** Delivery timeout in milliseconds. Bounded, no retries. */
  timeoutMs: number;
  /** Where undeliverable runs are appended, one JSON envelope per line. */
  outputPath: string;
  /**
   * Where keyless runs are appended — the local development record, kept
   * deliberately apart from the replay queue (`outputPath`). Two meanings,
   * two files: nothing on a written line says which sink it was destined
   * for, so a file that ever mixes them can never be separated after the
   * fact. Splitting at the writer is the only fix.
   */
  localOutputPath: string;
}

/**
 * First env value that carries content, trimmed — the port of the Ruby
 * client's `Configuration#first_present`, which does `env[key].to_s.strip`
 * and skips the key when the result is empty.
 *
 * The trim is the whole point: a whitespace-only value is UNSET, not a
 * value. Without it a blank `SPECGUARD_COMMIT_SHA` satisfied this predicate,
 * SHADOWED a resolvable `git rev-parse HEAD`, passed `buildEnvelope`'s
 * `=== ""` guard, and was refused 400 by the platform
 * (`Ingest::Payload#validate_commit_sha` requires `value.strip.present?`) —
 * landing a permanently undeliverable line in the replay queue, since
 * `deliverRawLine` re-posts the saved bytes as-is. Fixed once here, for
 * every key `readRunnerEnv` reads, rather than as a `commitSha` special
 * case: Ruby strips all of its own.
 *
 * The trimmed value is what is RETURNED, too. That is not a separate
 * decision: a padded-but-non-blank value keys the same run either way,
 * because the platform normalizes it (`payload.rb` stores
 * `@body["commit_sha"].strip`).
 */
function firstEnv(
  env: Record<string, string | undefined>,
  names: string[],
): string | null {
  for (const name of names) {
    const value = env[name];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed !== "") return trimmed;
  }
  return null;
}

function git(env: Record<string, string | undefined>, args: string[]): string | null {
  // Never let a git probe break anything — it is a fallback, not a requirement.
  try {
    const out = execFileSync("git", args, {
      env,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    })
      .toString()
      .trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/**
 * A runner-native shard index (Vitest/Jest `--shard=i/n`, node:test
 * `--test-shard=i/n`) as the string `shard_id` carries, or `null` when the
 * value is absent or malformed.
 *
 * Only a positive integer qualifies — the runners number their shards from 1
 * — and a number is stringified here, at the edge, because the endpoint
 * refuses a JSON number for `shard_id`. The INDEX alone is sent, never
 * `"2/4"`: the count rides no wire field, and a composite id would make a
 * suite's shard names depend on how many shards it happened to be split
 * into. Never throws, whatever it is handed.
 */
export function nativeShardIndex(value: unknown): string | null {
  try {
    let text: string;
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) return null;
      text = String(value);
    } else if (typeof value === "string") {
      text = value.trim();
    } else {
      return null;
    }
    if (!/^[0-9]+$/.test(text)) return null;
    const index = Number(text);
    if (!Number.isSafeInteger(index) || index < 1) return null;
    return String(index);
  } catch {
    return null;
  }
}

/**
 * The index out of a node:test `--test-shard=i/n` (or space-separated
 * `--test-shard i/n`) flag in `execArgv`, or `null` when there is no such
 * flag or its value is not `<index>/<count>` with `1 <= index <= count`.
 * The first occurrence wins, matching how Node reads a repeated flag's
 * value. Never throws.
 */
export function shardIndexFromTestShardFlag(
  execArgv: readonly string[] = process.execArgv,
): string | null {
  try {
    for (let i = 0; i < execArgv.length; i++) {
      const arg = execArgv[i];
      if (typeof arg !== "string") continue;
      let value: string | undefined;
      if (arg.startsWith("--test-shard=")) value = arg.slice("--test-shard=".length);
      else if (arg === "--test-shard") value = execArgv[i + 1];
      else continue;
      if (typeof value !== "string") return null;
      const match = /^([0-9]+)\/([0-9]+)$/.exec(value.trim());
      if (match === null) return null;
      const index = nativeShardIndex(match[1]);
      const count = nativeShardIndex(match[2]);
      if (index === null || count === null || Number(index) > Number(count)) return null;
      return index;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The runner-native shard fallback: `env` with `shardId` filled from the
 * runner's own `--shard` index, but ONLY where nothing else named the shard.
 * `shardId` is already resolved from `SPECGUARD_SHARD_ID` and the provider
 * keys by the time it gets here, so a non-null value is an explicit choice
 * (a composite `${os}-${shard}` id, say) and is returned untouched —
 * precedence is `SPECGUARD_SHARD_ID` > provider keys > runner-native.
 * Absent or malformed native values leave `shardId` as it was.
 */
export function withNativeShard(env: RunnerEnv, native: unknown): RunnerEnv {
  if (env.shardId !== null) return env;
  const index = nativeShardIndex(native);
  return index === null ? env : { ...env, shardId: index };
}

/** What a reporter learned from its runner, passed to {@link readRunnerEnv}. */
export interface RunnerHints {
  /** The runner's own shard index (`--shard=i/n`); lowest-precedence `shard_id`. */
  shardIndex?: unknown;
}

/**
 * Resolve the fixed list of environment variables the client reads. The
 * branch list is the Ruby client's `BRANCH_KEYS` plus `CI_COMMIT_BRANCH` —
 * a key the Ruby client does not read, kept so a GitLab run resolves its
 * branch even where only the branch name is set, and sitting directly
 * beside `CI_COMMIT_REF_NAME` in the first-wins order. The shared keys
 * keep the same meanings; when the Ruby list grows, this list grows with
 * it — superset, never equality. Nothing else is read.
 *
 * `shardId` falls back to the runner's own shard index (`hints.shardIndex`)
 * only when `SPECGUARD_SHARD_ID` and every provider key are unset.
 *
 * `ciRunId` and `shardId` are stringified HERE, at the edge, whatever they
 * arrived as: `JSON.stringify` emits a bare `0` for a number and the endpoint
 * refuses a JSON number for either field — `0` and `"0"` key different shards.
 */
export function readRunnerEnv(
  proc: Pick<NodeJS.Process, "env"> = process,
  hints: RunnerHints = {},
): RunnerEnv {
  const env = proc.env as Record<string, string | undefined>;

  const commitSha =
    firstEnv(env, [
      "SPECGUARD_COMMIT_SHA",
      "GITHUB_SHA",
      "CI_COMMIT_SHA",
      "CIRCLE_SHA1",
      "BUILDKITE_COMMIT",
      "GIT_COMMIT",
    ]) ?? git(env, ["rev-parse", "HEAD"]);

  const branch =
    firstEnv(env, [
      "SPECGUARD_BRANCH",
      "GITHUB_REF_NAME",
      "CI_COMMIT_REF_NAME",
      "CI_COMMIT_BRANCH",
      "CIRCLE_BRANCH",
      "BUILDKITE_BRANCH",
      "GIT_BRANCH",
    ]) ?? git(env, ["branch", "--show-current"]);

  const ciRunIdRaw = firstEnv(env, [
    "SPECGUARD_RUN_ID",
    "GITHUB_RUN_ID",
    "CI_PIPELINE_ID",
    "CIRCLE_WORKFLOW_ID",
    "BUILDKITE_BUILD_ID",
    "BUILD_TAG",
  ]);
  const shardIdRaw = firstEnv(env, [
    "SPECGUARD_SHARD_ID",
    "CI_NODE_INDEX",
    "CIRCLE_NODE_INDEX",
    "BUILDKITE_PARALLEL_JOB",
  ]);

  const timeoutSeconds = Number(
    firstEnv(env, ["SPECGUARD_TIMEOUT"]) ?? "10",
  );

  return withNativeShard({
    commitSha,
    branch,
    ciRunId: ciRunIdRaw === null ? null : String(ciRunIdRaw),
    shardId: shardIdRaw === null ? null : String(shardIdRaw),
    endpoint: firstEnv(env, ["SPECGUARD_ENDPOINT"]),
    apiKey: firstEnv(env, ["SPECGUARD_API_KEY"]),
    repositoryId: firstEnv(env, ["SPECGUARD_REPOSITORY_ID"]),
    timeoutMs:
      Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
        ? timeoutSeconds * 1000
        : 10_000,
    outputPath: firstEnv(env, ["SPECGUARD_OUTPUT_PATH"]) ?? "log/test_results.jsonl",
    localOutputPath:
      firstEnv(env, ["SPECGUARD_LOCAL_OUTPUT_PATH"]) ?? "log/test_results.local.jsonl",
  }, hints.shardIndex);
}
