import {
  LintBackendError,
  checkWithBackend,
  type ValidatorFinding,
} from "./backend.js";
import { LintUsageError, scanTokens, selectFiles } from "./discover.js";
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
}

export interface LintOptions extends ValidatorDeps {
  json?: boolean;
}

function aboutFile(kind: string): boolean {
  return kind === "read" || kind === "no-match";
}

/**
 * Run the lint. Returns the report with its exit code; NEVER throws past a
 * typed verdict (usage and backend failures are carried as exit-2 reports).
 */
export function lint(argv: string[], options: LintOptions = {}): LintReport {
  let selection;
  try {
    selection = selectFiles(argv);
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
      };
    }
    throw error;
  }

  const scans = scanTokens(selection.files);
  const tokenCount = scans.reduce((sum, scan) => sum + scan.tokens, 0);

  if (selection.files.length === 0) {
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
    };
  }

  const resolution = resolveValidator(options);

  if (resolution.state === "unavailable") {
    if (tokenCount === 0) {
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
          `specguard lint: warning: no annotations found in ${selection.files.length} file(s); the validator backend was not needed (${resolution.code})`,
        ],
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
        `specguard lint: error: ${tokenCount} @intent: annotation token(s) found but no validator backend could be resolved: ${resolution.reason}`,
      ],
    };
  }

  const backend = { path: resolution.path, identity: resolution.identity };
  const stderr = [
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
  };
}
