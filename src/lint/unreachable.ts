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
 * The GROUP arm (SPGD-1524) ports `Scanner.group_line_findings_in_text`
 * (Ruby SPGD-1510): an `@intent:` trailing on a describe/suite/context
 * GROUP line is dead in a second way — the line is no example's own and it
 * is not comment-only, so no lookback can ever claim it, and the example
 * beneath it silently ingests as unannotated (a describe insertion that
 * swallowed a newline is how the shape is born). A one-liner that defines
 * its own test is exempt — there the annotation belongs to the test on the
 * same line.
 *
 * Known heuristic limits, mirrored honestly from the Ruby twin's comments
 * (scanner.rb ~:407-446): the group selector keys on the keyword at line
 * start, the payload opener must be `{` (marker-based extraction, SPGD-8
 * §7, also finds the token inside quoted strings — this suite's own
 * description "unreachable stacked @intent: annotations" is prose, not an
 * annotation), and the one-liner exemption reads only the code BEFORE the
 * token, so prose can turn the exemption ON, never a real example OFF.
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
 * Why a group-line annotation fails: annotations attach to TESTS, never to
 * groups (SPGD-12 §2 — extraction is one-line and example-anchored), and a
 * group line is neither an example's own line nor comment-only, so no
 * lookback can ever claim it.
 */
const UNREACHABLE_GROUP_ANNOTATION =
  "unreachable annotation: this @intent: trails a describe/suite/context group line, " +
  "and annotations attach to tests, never to groups (SPGD-12 §2) — extraction is " +
  "one-line and example-anchored, so no test below can ever claim it. Move the payload " +
  "onto the test's own line, or to a `// @intent:` comment line directly above the test";

/**
 * The group-keyword analogue of the Ruby twin's `GROUP_LINE` (scanner.rb
 * ~:407): a line starting with a group keyword — optionally carrying the
 * runner modifiers that still open a GROUP (`describe.only(`, `suite.skip(`,
 * `context.todo(`, `describe.concurrent(`, `describe.each(...)`) — hosts a
 * group, not an example, and `AnnotationLookup`'s extraction can claim an
 * annotation only from an example's own line or the comment-only line above
 * it, so an `@intent:` written here is unreachable wherever it sits on the
 * line.
 */
const GROUP_LINE = /^\s*(?:describe|suite|context)(?:\.(?:only|skip|todo|concurrent|each))?\b/;

/**
 * A token WITH its payload opener, the TS analogue of the Ruby twin's
 * `INTENT_WITH_PAYLOAD` (scanner.rb ~:424). The `{` is load-bearing:
 * extraction is marker-based (SPGD-8 §7), so the token is ALSO found
 * inside quoted strings — this repo's own suite carries
 * `describe("unreachable stacked @intent: annotations", ...)`, which is
 * prose, not an annotation, and a bare `@intent:` search would flag it.
 * A line matching this is one the scanner captured a payload from (or
 * began capturing one), which is the population this pass has standing to
 * judge. The naive search inherits the scanner's string-literal limitation
 * in the exotic direction only: a group line whose prose embeds
 * `@intent: {` reads as annotated (a flag the pipeline independently
 * agrees with, since extraction captures that literal too), never the
 * reverse.
 */
const INTENT_WITH_PAYLOAD = /@intent:\s*\{/;

/**
 * The one-liner exemption, the TS analogue of the Ruby twin's
 * `EXAMPLE_ON_LINE` (scanner.rb ~:446): a group line that ALSO opens an
 * example on the same line is that example's own line, so its trailing
 * annotation is claimed by the example and must not be flagged:
 *
 *   describe("Cart", () => { test("adds", () => {}); }); // @intent: { ... }
 *
 * Two guards keep prose from reading as an example call. The match runs
 * against the code BEFORE the `@intent:` token — the payload is English an
 * author wrote about a behavior ("...when it( is given one"); reading the
 * payload WHOLE would let prose that carries a call behind an opener
 * (`"; test( again"`) exempt the shape this pass exists to flag. A call
 * must sit after a block opener (`{` or `;`) on the code side — the
 * description string is part of it. A bare `{` covers `() => {`, so a
 * separate `=>\s*\{` alternative would be redundant. What this heuristic
 * still cannot see: a description string containing the literal sequence
 * `{ it(`/`; it(` still reads as a call and is wrongly exempted — a missed
 * flag, and only ever a missed flag: prose can turn the exemption ON,
 * never a real example OFF. The one-line example's own payload is never
 * consulted, so a payload can never exempt anything.
 */
const EXAMPLE_ON_LINE = /(?:\{|;)\s*(?:it|test|specify)(?:\.(?:only|skip|todo))?\s*\(/;

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
 * The group-line findings for one file's source text, in line order: one per
 * describe/suite/context GROUP line carrying a trailing `@intent:` payload
 * (INTENT_WITH_PAYLOAD), for lines that define no example of their own
 * (EXAMPLE_ON_LINE). Comment-only (`//`-leading) lines are left to the
 * stacked pass above: a comment above a group is a different shape,
 * deliberately out of scope here (SPGD-1524 flags the group line ITSELF,
 * mirroring Ruby SPGD-1510). The guards run in the same order as the Ruby
 * twin's `group_line_findings_in_text`, and the one-liner exemption is
 * tested against the code BEFORE the token only, split on the token, so
 * payload prose can never exempt anything.
 */
export function groupLineFindingsInText(text: string, file: string): LintFinding[] {
  const lines = text.split("\n");
  const findings: LintFinding[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trimStart().startsWith("//")) continue;
    if (!GROUP_LINE.test(line)) continue;
    if (!INTENT_WITH_PAYLOAD.test(line)) continue;
    // The exemption sees the code before the token; the payload and anything
    // after it are prose and must never read as an example call. The token is
    // guaranteed present (INTENT_WITH_PAYLOAD just matched), so `split`
    // always yields the code side.
    const code = line.split("@intent:")[0]!;
    if (EXAMPLE_ON_LINE.test(code)) continue;
    findings.push({
      file,
      line: i + 1,
      kind: "unreachable",
      ok: false,
      errors: [UNREACHABLE_GROUP_ANNOTATION],
      intent: null,
      aboutFile: false,
    });
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
    const text = buf.toString("utf8");
    // Ruby parity (scanner.rb `unreachable_findings_in_text`): the two arms
    // are disjoint by construction — the stacked pass reads only `//`-leading
    // comment lines, the group pass only lines that are not — so the merge
    // cannot double-flag a line, and the per-file sort restores the
    // file-then-line order `unreachableFindings` promises. (`?? 0` is a type
    // accommodation only — ValidatorFinding.line is nullable for binary rows,
    // but both arms above always emit a 1-based line.)
    const perFile = [...stackedFindingsInText(text, file), ...groupLineFindingsInText(text, file)];
    perFile.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    findings.push(...perFile);
  }
  return findings;
}
