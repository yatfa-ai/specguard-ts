import type { Envelope, SpecRow } from "./types.js";
import type { RunnerEnv } from "./env.js";

/**
 * Build the ingest envelope. Returns null when no commit sha could be
 * resolved — the one required field with no fallback, and a payload without
 * it would be refused, so the run is dropped (with a warning) instead.
 */
export function buildEnvelope(
  specs: SpecRow[],
  env: Pick<RunnerEnv, "commitSha" | "branch" | "ciRunId" | "shardId">,
  durationSeconds: number | null,
): Envelope | null {
  if (env.commitSha === null || env.commitSha === "") return null;
  return {
    commit_sha: env.commitSha,
    branch: env.branch,
    // Stringified at the edge in readRunnerEnv; String() again here so a
    // caller composing values in code (a number) cannot reach the wire bare.
    ci_run_id: env.ciRunId === null ? null : String(env.ciRunId),
    shard_id: env.shardId === null ? null : String(env.shardId),
    duration_seconds:
      durationSeconds !== null && Number.isFinite(durationSeconds) && durationSeconds >= 0
        ? durationSeconds
        : null,
    specs,
  };
}
