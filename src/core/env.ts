import { execFileSync } from "node:child_process";

export interface RunnerEnv {
  commitSha: string | null;
  branch: string | null;
  ciRunId: string | null;
  shardId: string | null;
  endpoint: string | null;
  apiKey: string | null;
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

function firstEnv(
  env: Record<string, string | undefined>,
  names: string[],
): string | null {
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value !== "") return value;
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
 * Resolve the fixed list of environment variables the client reads — the same
 * list the Ruby client reads, with the same meanings. Nothing else is read.
 *
 * `ciRunId` and `shardId` are stringified HERE, at the edge, whatever they
 * arrived as: `JSON.stringify` emits a bare `0` for a number and the endpoint
 * refuses a JSON number for either field — `0` and `"0"` key different shards.
 */
export function readRunnerEnv(
  proc: Pick<NodeJS.Process, "env"> = process,
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
      "CI_COMMIT_BRANCH",
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

  return {
    commitSha,
    branch,
    ciRunId: ciRunIdRaw === null ? null : String(ciRunIdRaw),
    shardId: shardIdRaw === null ? null : String(shardIdRaw),
    endpoint: firstEnv(env, ["SPECGUARD_ENDPOINT"]),
    apiKey: firstEnv(env, ["SPECGUARD_API_KEY"]),
    timeoutMs:
      Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
        ? timeoutSeconds * 1000
        : 10_000,
    outputPath: firstEnv(env, ["SPECGUARD_OUTPUT_PATH"]) ?? "log/test_results.jsonl",
    localOutputPath:
      firstEnv(env, ["SPECGUARD_LOCAL_OUTPUT_PATH"]) ?? "log/test_results.local.jsonl",
  };
}
