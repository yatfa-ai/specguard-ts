import { isAbsolute, relative, sep } from "node:path";
import type { SpecRow } from "../core/types.js";
import { resolveValidator, type ValidatorDeps } from "../core/validator.js";
import { LintBackendError, checkWithBackend, type ValidatorFinding } from "../lint/backend.js";
import { scanTokens, selectFiles } from "../lint/discover.js";

/**
 * Slice 4: carry validator-ratified intent on telemetry.
 *
 * Before the reporter POSTs, the lint discovery + binary backend run over the
 * repository's annotated SOURCE FILES, and every `ok: true` finding is mapped
 * onto its `SpecRow` by (file, 1-based line). A matched row flips to
 * `status: "annotated"` and carries the finding's `intent` object VERBATIM —
 * this client never validates the payload's shape (that is the binary's job,
 * and the reason `src/lint/discover.ts` never parses payloads either).
 *
 * The (file, line) coordinate discipline: for `node:test`, the reporter
 * event's `data.line` points at the `test(...)` call line while the
 * annotation comment sits on the line ABOVE — measured on a real fixture
 * (pinned in test/annotate.test.ts) — so a finding matches a row when
 * `finding.line === row.line_number - LOOKBACK_LINES`.
 *
 * NEVER-FAIL (the single hardest constraint): every way this pass can fail —
 * binary missing, discovery unreadable, backend error, malformed annotation —
 * leaves the rows exactly as slice 1 produced them (all unannotated) with a
 * ONE-LINE stderr warning. It must never demote the never-fail guarantee:
 * malformed annotations are the lint command's product, not the reporter's,
 * and `ok: false` findings map to no row at all (never a warning per site).
 */

/**
 * The measured offset between a node:test row's line (the `test(...)`
 * call) and the annotation comment line — the comment sits on the line
 * above, mirroring the Ruby client's `AnnotationLookup` one-line lookback.
 */
export const ANNOTATION_LOOKBACK_LINES = 1;

/** Never-fail outcome of one annotation pass. */
export interface AnnotationOutcome {
  rows: SpecRow[];
  /** True when at least one row was flipped to "annotated". */
  annotated: number;
  /** True when the pass degraded (one-line warning already emitted). */
  degraded: boolean;
}

export interface AnnotateDeps extends ValidatorDeps {
  /** Repo root used both for discovery and file normalization (defaults to cwd). */
  repoRoot?: string;
  /** Warning sink (defaults to one line on process.stderr). */
  warn?: (message: string) => void;
}

/** Mirror the collector's path normalization: repo-relative, posix separators. */
function normalizeRepoPath(file: string, repoRoot: string): string {
  if (!isAbsolute(file)) return file.split(sep).join("/");
  const rel = relative(repoRoot, file);
  if (rel.startsWith("..") || isAbsolute(rel)) return file;
  return rel.split(sep).join("/");
}

/**
 * Run discovery + the binary backend and map passing findings onto `rows`.
 * Returns the rows (new array, originals untouched) with matches flipped to
 * `"annotated"` carrying the finding's `intent` verbatim. NEVER THROWS: every
 * failure degrades to the input rows plus one warning line.
 */
export function annotateRows(rows: readonly SpecRow[], deps: AnnotateDeps = {}): AnnotationOutcome {
  const warn = deps.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  const repoRoot = deps.repoRoot ?? process.cwd();

  if (rows.length === 0) return { rows: [...rows], annotated: 0, degraded: false };

  try {
    const selection = selectFiles([], repoRoot);
    if (selection.files.length === 0) return { rows: [...rows], annotated: 0, degraded: false };

    // The token gate from lint: a repository with no `@intent:` tokens needs
    // no binary, and absence is not failure — slice-1 rows ship untouched.
    const tokenCount = scanTokens(selection.files).reduce((sum, s) => sum + s.tokens, 0);
    if (tokenCount === 0) return { rows: [...rows], annotated: 0, degraded: false };

    const resolution = resolveValidator(deps);
    if (resolution.state === "unavailable") {
      warn(
        `SpecGuard: annotations present but the validator backend could not be resolved (${resolution.code}); telemetry ships unannotated. The test run is unaffected.`,
      );
      return { rows: [...rows], annotated: 0, degraded: true };
    }

    let findings: ValidatorFinding[];
    try {
      findings = checkWithBackend(resolution, selection.files);
    } catch (error) {
      const message = error instanceof LintBackendError ? error.message : String(error);
      warn(
        `SpecGuard: the validator backend failed (${message}); telemetry ships unannotated. The test run is unaffected.`,
      );
      return { rows: [...rows], annotated: 0, degraded: true };
    }

    // Key by (normalized file, 1-based line). Later findings never overwrite
    // an earlier passing one — first ratified finding wins, exactly like the
    // Ruby AnnotationLookup's first match.
    const byCoordinate = new Map<string, Record<string, unknown> | null>();
    for (const finding of findings) {
      if (!finding.ok || finding.line === null) continue; // ok:false maps to no row; file-shaped kinds have line null or are skipped below
      if (finding.kind === "read" || finding.kind === "no-match") continue;
      const key = `${normalizeRepoPath(finding.file, repoRoot)}:${finding.line}`;
      if (!byCoordinate.has(key)) byCoordinate.set(key, finding.intent);
    }

    let annotated = 0;
    const out = rows.map((row) => {
      // The row's line is the `test(...)` call; the annotation comment sits
      // LOOKBACK_LINES above it.
      const annotationLine = row.line_number - ANNOTATION_LOOKBACK_LINES;
      if (annotationLine <= 0) return row;
      const key = `${row.file_path}:${annotationLine}`;
      if (!byCoordinate.has(key)) return row;
      annotated += 1;
      return { ...row, status: "annotated" as const, intent: byCoordinate.get(key) ?? null };
    });
    return { rows: out, annotated, degraded: false };
  } catch {
    // Absolute never-fail backstop: an unexpected throw still ships slice-1
    // rows rather than taking the suite down.
    warn(
      `SpecGuard: the annotation pass failed unexpectedly; telemetry ships unannotated. The test run is unaffected.`,
    );
    return { rows: [...rows], annotated: 0, degraded: true };
  }
}
