import { annotateRows } from "../node-test/annotate.js";
import { buildEnvelope } from "./envelope.js";
import type { RunnerEnv } from "./env.js";
import { uniquifyRows } from "./id.js";
import { deliver, type TransportDeps } from "./transport.js";
import type { SpecRow } from "./types.js";
import type { ValidatorDeps } from "./validator.js";

/** What the pipeline needs from a runner's collector. */
export interface ShippableCollector {
  getRows(): readonly SpecRow[];
  durationSeconds(): number | null;
}

export interface ShipRunOptions {
  env: RunnerEnv;
  /** The repo root bound at run start (relativizing and annotation join). */
  repoRoot: string;
  validator?: ValidatorDeps | undefined;
  transport?: TransportDeps | undefined;
}

/**
 * The post-collection pipeline every reporter shares: uniquify ids → skip a
 * zero-test run (no POST, no file) → annotation pass → envelope → one stderr
 * line when no commit sha resolves → deliver.
 *
 * Does NOT catch: exceptions propagate so each reporter keeps its own
 * never-fail guard and runner-specific catch message. Runner-specific
 * warnings (`dropped` counts and the like) belong BEFORE the call.
 */
export async function shipRun(
  collector: ShippableCollector,
  options: ShipRunOptions,
): Promise<void> {
  const rows = uniquifyRows(collector.getRows());

  // A run that reported zero tests has nothing to say — no POST, no file.
  if (rows.length === 0) return;

  // The annotation pass never throws and never changes the exit code; on any
  // failure the unannotated rows ship as-is.
  const annotated = annotateRows(rows, {
    repoRoot: options.repoRoot,
    ...options.validator,
  });

  const envelope = buildEnvelope(annotated.rows, options.env, collector.durationSeconds());
  if (envelope === null) {
    process.stderr.write(
      "SpecGuard: no commit sha could be resolved (set SPECGUARD_COMMIT_SHA); telemetry not sent. The test run is unaffected.\n",
    );
    return;
  }

  await deliver(envelope, options.env, options.transport);
}
