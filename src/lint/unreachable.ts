import fs from "node:fs";

import { SCAN_MAX_BYTES } from "./discover.js";
import type { LintFinding } from "./lint.js";

/**
 * The structural pass of `specguard lint` (SPGD-1521): annotations that are
 * VALID in isolation but can never be extracted, so linting them clean is a
 * lie the binary alone cannot catch.
 *
 * This ports the stacked arm of `specguard-rspec`'s
 * `Scanner.stacked_findings_in_text` (SPGD-900) — the decision function was
 * diffed line by line against it, not summarized. The extraction contract
 * (SPGD-12 §2, both clients) is ONE-line and example-anchored: an example
 * claims the comment-form `@intent` line directly above itself, and
 * nothing else. So a run of ≥2 consecutive comment-form `@intent` lines
 * sitting immediately above an example is a stack of dead contracts: the
 * LAST line of the run is the one the lookback claims, and every line above
 * it in the run is silently discarded at extraction — well-formed metadata
 * no test will ever carry.
 *
 * The rule, exactly as the Ruby twin states it: walk maximal runs of
 * consecutive comment-form `@intent` lines; when the line right after the
 * run is an example line AND the run has ≥2 lines, flag every line of the
 * run EXCEPT THE LAST. Anchoring on the example keeps the pass off
 * annotation text with no example below it (notes, fixtures, a `const`
 * carrying an `@intent` in a string) — there is no lookback there to
 * silently discard anything, so there is nothing to report.
 *
 * Like the Ruby CLI's `unreachable_results`, these become LintFindings
 * appended to the binary's own, so both renderers and the exit code pick
 * them up with no second path to keep in step (`lint.ts`). The findings are
 * CLIENT-produced — they bypass backend.ts's FAILURE_KINDS vocabulary on
 * purpose, because "unreachable" names a structural fact about the file the
 * binary never sees, not a payload verdict the binary already gives.
 */

/** A comment-form line carrying an `@intent` token — the only form the line
 * directly above an example may claim. The `//` analogue of the Ruby twin's
 * `COMMENT_INTENT_LINE` (and of SPGD-1519's `COMMENT_ONLY_LINE`). */
const COMMENT_INTENT_LINE = /^\s*\/\/.*@intent:/;

/**
 * The line an annotation run may be claimed from: the first example keyword.
 * The TS analogue of the Ruby twin's `EXAMPLE_LINE` — `it`/`test`/`specify`
 * at the start of a line, with the runner modifiers that still open an
 * example (`it.only(`, `test.skip(`, `test.todo(`).
 */
const EXAMPLE_LINE = /^\s*(?:it|test|specify)(?:\.(?:only|skip|todo))?\s*\(/;

/** Why a stacked line fails: the lookback claims only the line directly
 * above the example, so this one is discarded at extraction. The remedy is
 * the merge the Ruby twin asks for too. */
const UNREACHABLE_ANNOTATION =
  "unreachable annotation: the line above is also a comment-form @intent:, and the " +
  "one-line lookback claims only the comment line directly above the test — this " +
  "annotation is discarded at extraction (SPGD-12 §2). Merge its behavior into that " +
  "single @intent: line";

/**
 * The stacked findings for one file's source text, in line order: one per
 * comment-form `@intent` line in a run of ≥2 sitting immediately above an
 * example line, except the run's LAST line (which the lookback claims).
 */
export function stackedFindingsInText(text: string, file: string): LintFinding[] {
  const lines = text.split("\n");
  const findings: LintFinding[] = [];
  let i = 0;

  while (i < lines.length) {
    if (!COMMENT_INTENT_LINE.test(lines[i]!)) {
      i += 1;
      continue;
    }

    const runStart = i;
    i += 1;
    while (i < lines.length && COMMENT_INTENT_LINE.test(lines[i]!)) {
      i += 1;
    }
    const runEnd = i; // exclusive; lines[runEnd] is the line after the run

    if (runEnd < lines.length && EXAMPLE_LINE.test(lines[runEnd]!) && runStart < runEnd - 1) {
      for (let j = runStart; j < runEnd - 1; j += 1) {
        findings.push({
          file,
          line: j + 1,
          kind: "unreachable",
          ok: false,
          errors: [UNREACHABLE_ANNOTATION],
          intent: null,
          aboutFile: false,
        });
      }
    }
  }

  return findings;
}

/**
 * The structural findings over the selection. A file the pass cannot read —
 * unreadable, or over SCAN_MAX_BYTES, the same budget `scanTokens` applies —
 * contributes NOTHING: the existing exit-2 arms already speak for such files
 * (`unscannable` / the binary's `read` finding), and a crash here would
 * borrow exit 1, the code that means "an annotation is malformed". Exit 1
 * must come from a verdict, never from a crash.
 */
export function unreachableFindings(files: string[]): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const file of files) {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(file);
    } catch {
      continue;
    }
    if (buf.byteLength > SCAN_MAX_BYTES) continue;
    findings.push(...stackedFindingsInText(buf.toString("utf8"), file));
  }
  return findings;
}
