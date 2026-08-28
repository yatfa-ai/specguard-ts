import { createHash } from "node:crypto";

/**
 * Compose the stable per-example id — the `(test_run_id, example_id)` upsert
 * key on the platform. It must be stable across runs for an unchanged test,
 * stable across shards, and independent of execution order — so it is derived
 * only from the project-relative file path and the composed full name, never
 * from an index into the run.
 */
export function exampleId(filePath: string, composedName: string): string {
  return createHash("sha1")
    .update(`${filePath}\u0000${composedName}`)
    .digest("hex");
}
