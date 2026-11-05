import type { SpecRow } from "./types.js";
import { exampleId } from "./id.js";

/**
 * The fixed tail of the row name every adapter gives a test FILE that failed
 * to run at all (a syntax error, a throwing top-level statement, a missing
 * import). The full name is `<project-relative posix path> > <this>`.
 *
 * It is a WIRE CONTRACT, not a label: identity on the platform is semantic
 * over the name, and the unstable-test ranking keys on it, so the same file
 * must produce the same name on every run and every machine — which is why
 * the path is the repo-relative one, never the absolute path a runner
 * reports. Changing this string re-identifies every crashed file in
 * history; it is pinned by a test.
 */
export const FILE_FAILED_NAME_SUFFIX = "(test file failed to run)";

/** The stable row name for a test file that failed to run. */
export function fileFailedName(filePath: string): string {
  return `${filePath} > ${FILE_FAILED_NAME_SUFFIX}`;
}

/**
 * The ONE row a crashed test file ships, identical across the three
 * adapters: line 1 (the wire refuses a payload with a line below 1, and a
 * file that never ran has no test line), outcome "failed", unannotated.
 * `duration` is seconds, or null when the runner reported none.
 */
export function fileFailedRow(filePath: string, duration: number | null): SpecRow {
  const name = fileFailedName(filePath);
  return {
    file_path: filePath,
    line_number: 1,
    status: "unannotated",
    intent: null,
    name,
    duration,
    id: exampleId(filePath, name),
    outcome: "failed",
  };
}
