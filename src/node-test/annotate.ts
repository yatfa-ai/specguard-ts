import { isAbsolute, relative, sep } from "node:path";
import type { SpecRow } from "../core/types.js";
import { resolveValidator, type ValidatorDeps } from "../core/validator.js";
import { LintBackendError, checkWithBackend, type ValidatorFinding } from "../lint/backend.js";
import { SCAN_MAX_BYTES, scanTokens, selectFiles } from "../lint/discover.js";

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
    // SPGD-929: the gate consults the `unscannable` flag SPGD-926 added —
    // a `tokens: 0` over an unreadable/oversized file is "could not look",
    // never "nothing to check", so that arm degrades LOUDLY (one warning).
    // The pass still never fails a run: no throw, no exit-code change, and
    // the rows return untouched on every arm.
    const scans = scanTokens(selection.files);
    const tokenCount = scans.reduce((sum, scan) => sum + scan.tokens, 0);
    const unscannable = scans.filter((scan) => scan.unscannable);
    if (tokenCount === 0 && unscannable.length === 0) {
      return { rows: [...rows], annotated: 0, degraded: false };
    }
    if (tokenCount === 0 && unscannable.length > 0) {
      // SPGD-929's arm. With zero tokens no binary is ever resolved, so this
      // one line is the pass's only warning. The tokens-present arm below
      // degrades on the UNREADABLE of those unscannable files — the oversize
      // arm is exempt there, SPGD-1006: the backend reads oversize files and
      // annotates their rows — plus the binary's read findings, folded into
      // one de-duplicated line, so the pass warns at most once.
      const named = unscannable.map((scan) => scan.file);
      warn(
        `SpecGuard: ${unscannable.length} file(s) could not be scanned (unreadable or larger than ${SCAN_MAX_BYTES} bytes): ${named.join(", ")}; telemetry ships unannotated. The test run is unaffected.`,
      );
      return { rows: [...rows], annotated: 0, degraded: true };
    }

    // SPGD-971: the tokens-present arm carries the same duty SPGD-929 gave
    // its sibling above — a file NO reader could look at is "could not
    // look", never "nothing to check". Two sources feed the POST-BACKEND
    // name list below, de-duplicated, so a file that is both unscannable
    // (its unreadable arm) and read-failed is named once and the pass still
    // emits at most one warning line:
    //   * discovery-side: only the UNREADABLE arm of `unscannable` from
    //     scanTokens — the oversize arm is excluded from this list, riding
    //     `unscannableNames` into the early-fail arms only (the split is
    //     SPGD-1006's; see the block beneath this one), and
    //   * backend-side: `kind: "read"` findings that the row-mapping loop
    //     below would otherwise silently skip (a read finding carries
    //     ok:false, so its first `continue` drops it — the count must be
    //     taken before that skip; the loop itself is untouched).
    // `no-match` is deliberately NOT folded in: an unmatched file is not an
    // unreadable one, whatever lint.ts's aboutFile() lumps together. The
    // never-fail guarantee is untouched: no throw, no exit-code change.
    //
    // SPGD-1006: the two sources do NOT license the same downstream claim,
    // so they no longer share one list. Discovery's `unscannable` carries
    // two facts: OVERSIZE is this client's token-scan budget only
    // (SCAN_MAX_BYTES) — the validate-intent binary has no size cap, reads
    // the file, and ratifies its annotations, so its rows annotate below;
    // UNREADABLE (the catch arm) is a file nobody can look at, so the
    // backend can return no passing finding for it. Hence:
    //   * `unscannableNames` — every file the token scan could not look at,
    //     both classes — feeds the two EARLY-FAIL arms below, where nothing
    //     was validated at all and "unreadable or larger than N bytes" is
    //     the honest register (the SPGD-929 arm above keeps it too); and
    //   * `unannotatableNames` — built after the backend returns, unreadable
    //     discovery-side plus the binary's own read failures — feeds the
    //     post-backend "ships unannotated" warning and `degraded`, where an
    //     oversize file must NOT appear: naming it there called the very
    //     rows this pass annotated "unannotated".
    const unscannableNames: string[] = unscannable.map((scan) => scan.file);
    const unreadableClause = (): string =>
      `${unscannableNames.length} file(s) could not be scanned (unreadable or larger than ${SCAN_MAX_BYTES} bytes): ${unscannableNames.join(", ")}`;

    const resolution = resolveValidator(deps);
    if (resolution.state === "unavailable") {
      warn(
        unscannableNames.length === 0
          ? `SpecGuard: annotations present but the validator backend could not be resolved (${resolution.code}); telemetry ships unannotated. The test run is unaffected.`
          : `SpecGuard: ${unreadableClause()}; annotations present but the validator backend could not be resolved (${resolution.code}); telemetry ships unannotated. The test run is unaffected.`,
      );
      return { rows: [...rows], annotated: 0, degraded: true };
    }

    let findings: ValidatorFinding[];
    try {
      findings = checkWithBackend(resolution, selection.files);
    } catch (error) {
      const message = error instanceof LintBackendError ? error.message : String(error);
      warn(
        unscannableNames.length === 0
          ? `SpecGuard: the validator backend failed (${message}); telemetry ships unannotated. The test run is unaffected.`
          : `SpecGuard: ${unreadableClause()}; the validator backend failed (${message}); telemetry ships unannotated. The test run is unaffected.`,
      );
      return { rows: [...rows], annotated: 0, degraded: true };
    }

    // Count the binary's read failures BEFORE the row-mapping loop skips
    // them — the same predicate lint.ts counts as `unreadable`, restricted
    // to `read`. The two `continue`s below stay exactly as they are; what
    // changes is that the information is counted above the skip.
    const readFailed = findings.filter((finding) => finding.kind === "read" && !finding.ok);

    // SPGD-1006: the "ships unannotated" list is unreadable-only BY
    // CONSTRUCTION — discovery's catch arm plus the binary's own read
    // failures, de-duplicated on the normalized path. A file on this list
    // is one NO reader could look at, so the backend returned no passing
    // finding for it (a read finding carries ok:false and maps to no row)
    // and none of its rows can annotate — THAT is the guarantee the warning
    // below makes, and it now holds for every name on the list. An oversize
    // file is deliberately absent: the binary reads it (no size cap
    // binary-side) and its passing findings map below, so naming it here
    // would claim "ships unannotated" about rows this same pass annotates.
    const unannotatableNames: string[] = [];
    const seenUnannotatable = new Set<string>();
    const rememberUnannotatable = (file: string): void => {
      // Key on the NORMALIZED path, not the raw string: discovery names files
      // absolutely (path.join(root, …)) while the backend echoes whatever it
      // was handed, so the same file can arrive under two spellings. Only the
      // normalized key makes them collapse to one entry.
      const key = normalizeRepoPath(file, repoRoot);
      if (seenUnannotatable.has(key)) return;
      seenUnannotatable.add(key);
      unannotatableNames.push(file);
    };
    for (const scan of unscannable) {
      if (scan.unscannableReason === "unreadable") rememberUnannotatable(scan.file);
    }
    for (const finding of readFailed) rememberUnannotatable(finding.file);
    if (unannotatableNames.length > 0) {
      // The cap register ("unreadable or larger than N bytes") belongs to
      // the early-fail arms above and to lint.ts, where oversize files CAN
      // appear. Every name on THIS list is unreadable — never oversize — so
      // the clause says exactly that.
      warn(
        `SpecGuard: ${unannotatableNames.length} file(s) could not be scanned (unreadable): ${unannotatableNames.join(", ")}; those files ship unannotated. The test run is unaffected.`,
      );
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
      // SPGD-1011: the row leg keys through the SAME normalization as the
      // finding leg above. A raw `row.file_path` can never meet the map: on
      // Windows every node:path helper yields backslash spellings
      // (`a\special\login.test.ts` vs `a/special/login.test.ts` — never
      // equal, so every annotated row silently launders to "unannotated"),
      // and even on POSIX any spelling that differs from discovery's
      // (absolute pass-through) misses. Key-construction only.
      const key = `${normalizeRepoPath(row.file_path, repoRoot)}:${annotationLine}`;
      if (!byCoordinate.has(key)) return row;
      annotated += 1;
      return { ...row, status: "annotated" as const, intent: byCoordinate.get(key) ?? null };
    });
    // SPGD-971, narrowed by SPGD-1006: degraded when at least one file was
    // looked at by NO reader — unreadable discovery-side, or read-failed
    // backend-side. An oversize-only pass does NOT degrade: the backend read
    // every named file, and every row the mapping above could annotate did.
    return { rows: out, annotated, degraded: unannotatableNames.length > 0 };
  } catch {
    // Absolute never-fail backstop: an unexpected throw still ships slice-1
    // rows rather than taking the suite down.
    warn(
      `SpecGuard: the annotation pass failed unexpectedly; telemetry ships unannotated. The test run is unaffected.`,
    );
    return { rows: [...rows], annotated: 0, degraded: true };
  }
}
