import {
  LintBackendError,
  checkWithBackend,
  type ValidatorFinding,
} from "./backend.js";
import {
  ANNOTATED_EXTENSIONS,
  LintUsageError,
  SCAN_MAX_BYTES,
  scanTokens,
  selectFiles,
  type FileSelection,
} from "./discover.js";
import { resolveValidator, type ValidatorDeps } from "../core/validator.js";

/**
 * `specguard lint` orchestration: discovery → binary validation → verdict.
 *
 * The exit contract, mirroring the Ruby client's `specguard-lint` (the code
 * the ticket names as the contract to match):
 *
 *   0  every annotation checked was valid — INCLUDING "there were none".
 *      An annotation-free repository is exit 0 even with no binary resolved:
 *      "empty ≠ failure", and exit 2 is reserved for a run that had
 *      something to check and could not;
 *   1  at least one annotation is malformed. The ONLY code produced by
 *      inspecting content, reached in exactly one place below;
 *   2  the linter could not do its job — misuse, an unresolvable/broken
 *      binary when annotations DID exist to validate, or a backend failure.
 *      Exit 1 is produced in exactly one place so it means that and nothing
 *      else; every internal failure lands on 2, never on 1.
 *
 * Like the Ruby CLI, an exit-2 run emits NO report document: a document is a
 * report about what was checked, and a run that checked nothing must not
 * dress "could not check" as structure.
 */

export const EXIT_OK = 0;
export const EXIT_MALFORMED = 1;
export const EXIT_MISUSE = 2;

export interface LintFinding extends ValidatorFinding {
  /** True for file-shaped kinds (read / no-match): not annotation sites. */
  aboutFile: boolean;
}

export interface LintSummary {
  files: number;
  annotations: number;
  malformed: number;
  unreadable: number;
}

export interface LintReport {
  ok: boolean;
  exitCode: number;
  /** Which validator produced the verdicts — the run must say, or it is unrecoverable from the output. */
  backend: { path: string; identity: string | null } | null;
  /** Why no binary produced verdicts, when that is the state (exit 0 with none needed, or exit 2). */
  backendNote: string | null;
  summary: LintSummary;
  findings: LintFinding[];
  /** Provenance/errors for stderr — never part of the stdout document. */
  stderr: string[];
  /** How the files in scope were selected. Null on the misuse paths, where
   * selection never happened. The renderers disclose it only for `changed`
   * runs, so walk/explicit documents stay byte-identical to their previous
   * shape. */
  selection: FileSelection | null;
}

export interface LintOptions extends ValidatorDeps {
  json?: boolean | undefined;
  /** Select files from the git diff (`--changed`) instead of the walk. */
  changed?: boolean | undefined;
  /** Explicit diff base for changed mode (`--changed=<base>`); undefined
   * derives the merge base with the default branch. */
  base?: string | undefined;
}

/** Null-tolerant by design: only FAILING findings carry a kind, and a passing
 * finding's kind is null (the binary's documented shape — see backend.ts). */
function aboutFile(kind: string | null): boolean {
  return kind === "read" || kind === "no-match";
}

/**
 * Names the filter that actually emptied a `--changed` selection. Saying
 * "nothing in the diff matched" when an annotated file demonstrably changed —
 * just not under this directory — is worse than saying nothing: it reads as a
 * conclusion and stops the reader looking. `outsideRoot` and `unreadable`
 * are independent counters over disjoint branches of the same partition, so
 * both can be positive at once and the clauses are additive — naming only
 * the first would leave the reader doing arithmetic and concluding the
 * missing files were checked (the Ruby client's `changed_empty_reason` /
 * `changed_excluded_reason` ported verbatim in structure).
 */
function changedEmptyReason(selection: FileSelection): string {
  // Invariant: selectChanged is the only producer of mode "changed" and it
  // always populates base and stats.
  const stats = selection.stats!;
  const base = selection.base!;

  if (stats.changed === 0) return `nothing changed against ${base}`;
  if (stats.matches === 0) {
    return (
      `${stats.changed} file${stats.changed === 1 ? "" : "s"} changed against ${base}, ` +
      `none matching the annotated extensions (${ANNOTATED_EXTENSIONS.join(", ")})`
    );
  }

  const matched =
    `${stats.matches} changed annotated-source file${stats.matches === 1 ? "" : "s"} against ${base}`;
  if (stats.outsideRoot === 0) return `${matched} could not be read`;

  let reason =
    `${matched}, but ${stats.outsideRoot} ${stats.outsideRoot === 1 ? "is" : "are"} outside ` +
    `${process.cwd()} (--changed selects only files under the current directory)`;
  if (stats.unreadable > 0) reason += ` and ${stats.unreadable} could not be read`;
  return reason;
}

/**
 * Run the lint. Returns the report with its exit code; NEVER throws past a
 * typed verdict (usage and backend failures are carried as exit-2 reports).
 */
export function lint(argv: string[], options: LintOptions = {}): LintReport {
  let selection;
  try {
    selection = selectFiles(argv, process.cwd(), {
      changed: options.changed === true,
      base: options.base,
    });
  } catch (error) {
    if (error instanceof LintUsageError) {
      return {
        ok: false,
        exitCode: EXIT_MISUSE,
        backend: null,
        backendNote: null,
        summary: { files: 0, annotations: 0, malformed: 0, unreadable: 0 },
        findings: [],
        stderr: [`specguard lint: error: ${error.message}`],
        selection: null,
      };
    }
    throw error;
  }

  // `--changed` provenance that can only produce a thin selection is never
  // silent: the HEAD-fallback / base-is-HEAD disclosure rides stderr on EVERY
  // changed run that carries it, empty selection or not. A quiet degrade to
  // diff-HEAD is the SPGD-76-shaped failure this mode exists to prevent.
  const noteLines =
    selection.mode === "changed" && selection.note !== null
      ? [`specguard lint: warning: ${selection.note}`]
      : [];

  const scans = scanTokens(selection.files);
  const tokenCount = scans.reduce((sum, scan) => sum + scan.tokens, 0);
  // SPGD-926: `scanTokens` launders an unreadable or oversized file into
  // `tokens: 0`, so the count alone cannot tell "could not look" from
  // "looked, found nothing" — carry the flag that can.
  const unscannable = scans.filter((s) => s.unscannable);

  if (selection.files.length === 0) {
    if (selection.mode === "changed") {
      // The diff legitimately selected nothing, and the exit stays 0 — the
      // exit code is not the lever ("checked nothing" must never read as
      // "checked N files, found nothing"). What is load-bearing is stderr
      // naming WHICH filter emptied the selection: nothing changed at all,
      // nothing matched the annotated extensions, or everything that matched
      // is outside the current directory. A confidently wrong reason is
      // worse than a quiet one (the Ruby client's `changed_empty_reason`).
      return {
        ok: true,
        exitCode: EXIT_OK,
        backend: null,
        backendNote: null,
        summary: { files: 0, annotations: 0, malformed: 0, unreadable: 0 },
        findings: [],
        stderr: [
          `specguard lint: warning: selected 0 annotated source files — ${
            changedEmptyReason(selection)
          }`,
          ...noteLines,
        ],
        selection,
      };
    }
    // Nothing in scope. Loud on stderr (so "checked nothing" is never
    // mistaken for "checked 12 files, found nothing"), exit 0 by contract.
    return {
      ok: true,
      exitCode: EXIT_OK,
      backend: null,
      backendNote: null,
      summary: { files: 0, annotations: 0, malformed: 0, unreadable: 0 },
      findings: [],
      stderr: [
        `specguard lint: warning: selected 0 annotated source files — nothing to check`,
      ],
      selection,
    };
  }

  const resolution = resolveValidator(options);

  if (resolution.state === "unavailable") {
    if (tokenCount === 0 && unscannable.length === 0) {
      // The one deliberate degrade: nothing to validate, so no binary is
      // needed and absence is not failure. Say so — "could not check" and
      // "nothing to check" are different statements and a checker owes both.
      return {
        ok: true,
        exitCode: EXIT_OK,
        backend: null,
        backendNote: `not validated: ${resolution.reason}`,
        summary: { files: selection.files.length, annotations: 0, malformed: 0, unreadable: 0 },
        findings: [],
        stderr: [
          ...noteLines,
          `specguard lint: warning: no annotations found in ${selection.files.length} file(s); the validator backend was not needed (${resolution.code})`,
        ],
        selection,
      };
    }
    if (unscannable.length > 0) {
      // Files the client itself could not scan, and no binary to report the
      // read failure either — the client is the only witness left, so "could
      // not check" must be said here, never laundered into the degrade above
      // by the `tokens: 0` the swallow sites produced. Findings stay empty:
      // the client must not manufacture findings only the binary can report
      // (and cli.ts then suppresses the stdout document entirely).
      const named = unscannable.map((s) => s.file);
      return {
        ok: false,
        exitCode: EXIT_MISUSE,
        backend: null,
        backendNote: `${unscannable.length} file(s) could not be scanned (unreadable or larger than ${SCAN_MAX_BYTES} bytes): ${named.join(", ")}`,
        summary: {
          files: selection.files.length,
          annotations: 0,
          malformed: 0,
          unreadable: unscannable.length,
        },
        findings: [],
        stderr: [
          ...noteLines,
          `specguard lint: error: ${unscannable.length} file(s) could not be scanned (unreadable or larger than ${SCAN_MAX_BYTES} bytes): ${named.join(", ")}`,
        ],
        selection,
      };
    }
    // Annotations exist and nothing can validate them: the operator could
    // fix this (the env var, the override, the platform prebuilt), which is
    // exactly the exit-2 band.
    return {
      ok: false,
      exitCode: EXIT_MISUSE,
      backend: null,
      backendNote: resolution.reason,
      summary: {
        files: selection.files.length,
        annotations: 0,
        malformed: 0,
        unreadable: 0,
      },
      findings: [],
      stderr: [
        ...noteLines,
        `specguard lint: error: ${tokenCount} @intent: annotation token(s) found but no validator backend could be resolved: ${resolution.reason}`,
      ],
      selection,
    };
  }

  const backend = { path: resolution.path, identity: resolution.identity };
  const stderr = [
    ...noteLines,
    `specguard lint: validated by ${resolution.path}` +
      (resolution.identity !== null ? ` (${resolution.identity})` : ""),
  ];

  let raw: ValidatorFinding[];
  try {
    raw = checkWithBackend(resolution, selection.files);
  } catch (error) {
    const message = error instanceof LintBackendError ? error.message : `internal error: ${String(error)}`;
    return {
      ok: false,
      exitCode: EXIT_MISUSE,
      backend,
      backendNote: message,
      summary: { files: selection.files.length, annotations: 0, malformed: 0, unreadable: 0 },
      findings: [],
      stderr: [`specguard lint: error: ${message}`],
      selection,
    };
  }

  const findings: LintFinding[] = raw.map((f) => ({ ...f, aboutFile: aboutFile(f.kind) }));
  const malformed = findings.filter((f) => !f.aboutFile && !f.ok).length;
  const unreadable = findings.filter((f) => f.aboutFile && !f.ok).length;
  const annotations = findings.filter((f) => !f.aboutFile).length;

  if (unreadable > 0) {
    // A file that could not be read is "could not do its job" — exit 2 —
    // never a borrowed exit 1: the contract spends 1 on malformed
    // annotations only.
    const named = findings
      .filter((f) => f.aboutFile && !f.ok)
      .map((f) => f.file);
    return {
      ok: false,
      exitCode: EXIT_MISUSE,
      backend,
      backendNote: `${unreadable} file(s) could not be read: ${named.join(", ")}`,
      summary: { files: selection.files.length, annotations, malformed, unreadable },
      findings,
      stderr: [
        ...stderr,
        `specguard lint: error: ${unreadable} file(s) could not be read: ${named.join(", ")}`,
      ],
      selection,
    };
  }

  return {
    ok: malformed === 0,
    exitCode: malformed > 0 ? EXIT_MALFORMED : EXIT_OK,
    backend,
    backendNote: null,
    summary: { files: selection.files.length, annotations, malformed, unreadable },
    findings,
    stderr,
    selection,
  };
}
