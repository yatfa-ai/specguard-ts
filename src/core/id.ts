import { createHash } from "node:crypto";
import type { SpecRow } from "./types.js";

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

/** What {@link uniquifyIds} did: the rows to ship, and how many it re-identified per file. */
export interface UniquifyOutcome {
  rows: SpecRow[];
  /** file_path -> number of rows in that file that took an ordinal id. Empty when nothing collided. */
  disambiguated: Map<string, number>;
}

/**
 * Re-identify rows that would otherwise share an `id`.
 *
 * {@link exampleId} hashes only `(file_path, composed name)`, so a loop of
 * `test("adds", ...)`, an `it.each(rows)("works", ...)` with no placeholder,
 * or a repeated title yields N rows with one id — and the platform keeps only
 * the first row per `(test_run_id, example_id)`, silently dropping a failing
 * repeat. This is the specguard-ruby Minitest reporter's `uniquify_ids!`
 * decision, ported:
 *
 * - ALL members of a colliding group take the suffix, never just the later
 *   arrivals — otherwise the first row's id would change the day a duplicate
 *   title is added.
 * - The ordinal `k` (1-based) is the row's position within its group in the
 *   order `rows` is given — the collectors' emit (definition) order, never
 *   duration or completion time.
 * - Rows whose id no other row claims keep their id byte for byte.
 *
 * Only `id` changes; `name` and every other field pass through. The input is
 * not mutated. A file belongs to one shard, so no cross-shard rule is needed.
 */
export function uniquifyIds(rows: readonly SpecRow[]): UniquifyOutcome {
  const sizes = new Map<string, number>();
  for (const row of rows) sizes.set(row.id, (sizes.get(row.id) ?? 0) + 1);

  const seen = new Map<string, number>();
  const disambiguated = new Map<string, number>();
  const out = rows.map((row) => {
    if ((sizes.get(row.id) ?? 0) < 2) return row;
    const k = (seen.get(row.id) ?? 0) + 1;
    seen.set(row.id, k);
    disambiguated.set(row.file_path, (disambiguated.get(row.file_path) ?? 0) + 1);
    return {
      ...row,
      id: createHash("sha1")
        .update(`${row.file_path}\u0000${row.name}\u0000#${k}`)
        .digest("hex"),
    };
  });
  return { rows: out, disambiguated };
}

/** The most files the one warning line names before summarising the rest. */
const MAX_FILES_NAMED = 5;

/**
 * {@link uniquifyIds} for a reporter: returns the rows to ship and writes at
 * most one stderr line per run naming the files and how many rows were
 * disambiguated. Never throws — on any failure the rows ship unchanged, the
 * never-fail guarantee every reporter step is held to.
 */
export function uniquifyRows(rows: readonly SpecRow[]): SpecRow[] {
  try {
    const { rows: out, disambiguated } = uniquifyIds(rows);
    if (disambiguated.size > 0) {
      const entries = [...disambiguated.entries()];
      const total = entries.reduce((sum, [, n]) => sum + n, 0);
      const named = entries
        .slice(0, MAX_FILES_NAMED)
        .map(([file, n]) => `${file} (${n})`)
        .join(", ");
      const more =
        entries.length > MAX_FILES_NAMED ? `, and ${entries.length - MAX_FILES_NAMED} more file(s)` : "";
      process.stderr.write(
        `SpecGuard: disambiguated ${total} test(s) sharing a file and name by position: ${named}${more}. The test run is unaffected.\n`,
      );
    }
    return out;
  } catch {
    return [...rows];
  }
}
