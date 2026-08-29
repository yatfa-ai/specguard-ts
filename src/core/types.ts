/**
 * The per-example row this client sends — one object per test that finished.
 * Slice 1 is cold-start only: `status` is always "unannotated" and `intent`
 * always null, because nothing here reads `@intent:` annotations.
 */
export interface SpecRow {
  /** Project-relative path of the file the test lives in. Non-empty. */
  file_path: string;
  /** 1-based line of the test declaration. Positive integer, required. */
  line_number: number;
  status: "annotated" | "unannotated";
  /**
   * Null when unannotated; when annotated, the validator-ratified intent
   * payload carried verbatim from the binary's finding (slice 4). The client
   * never validates the object's shape — that verdict belongs to
   * `validate-intent`.
   */
  intent: Record<string, unknown> | null;
  /** The composed describe/context/it name — required when intent is null. */
  name: string;
  /** Seconds, not milliseconds. Non-negative, or null when unmeasured. */
  duration: number | null;
  /**
   * The upsert key — unvalidated by the endpoint, stability is entirely the
   * client's job. Composed as a hash over file_path + composed name.
   */
  id: string;
  /** Free text, echoed back verbatim. "passed" | "failed" | "pending". */
  outcome: string;
}

/** The ingest envelope — one per process. */
export interface Envelope {
  commit_sha: string;
  branch: string | null;
  /** String, never a JSON number — the endpoint refuses numbers. */
  ci_run_id: string | null;
  /** String, never a JSON number — the endpoint refuses numbers. */
  shard_id: string | null;
  duration_seconds: number | null;
  specs: SpecRow[];
}
