import fs from "node:fs";

import { SCAN_MAX_BYTES } from "./discover.js";
import type { LintFinding } from "./lint.js";

/**
 * The structural pass of `specguard lint` (SPGD-1521): annotations that are
 * VALID in isolation but can never be extracted, so linting them clean is a
 * lie the binary alone cannot catch.
 *
 * This ports the stacked arm of `specguard-ruby`'s
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
 * The SEPARATED arm (SPGD-1550) is a third way to be dead (originated in TS,
 * since mirrored in specguard-ruby `scanner.rb`
 * `separated_findings_in_text`, SPGD-1554): a comment-form `@intent:` run whose last line is separated from
 * its example by exactly ONE intervening line — a blank, or an ordinary
 * comment without an `@intent:` token. The one-line lookback claims only the
 * line directly above the example, so the annotation is discarded at
 * extraction while linting clean (a note inserted under the annotation, or a
 * formatter adding a blank, is how the shape is born). The rule: for each
 * maximal run of comment-form `@intent:` lines ending at L, flag EVERY line
 * of the run when `lines[L+1]` is blank or a non-`@intent` comment AND
 * `lines[L+2]` is an example line. The stacked arm requires an example at
 * the run's end and this one requires a blank/comment there, so the arms
 * are mutually exclusive by construction. Code between, longer gaps, and a
 * `describe(` beneath (SPGD-1522's deferral) are out of scope.
 *
 * The OWN-LINE-SHADOW arm (SPGD-1556) is a fourth way to be dead (also
 * originally TS-only, since mirrored in specguard-ruby `scanner.rb`
 * `own_line_shadow_findings_in_text`, SPGD-1560): a comment-form `@intent:` run directly above an example
 * line that ALSO carries its own trailing `@intent: {…}` payload. Extraction
 * is own-line-first (annotate.ts ARM 1 returns the row's own annotation
 * before ARM 2, the comment-above lookback, is consulted), so the comment
 * above can never be claimed by any test — while linting clean. The repo's
 * own fixture pins the extraction half deliberately
 * (`fixtures/annotated-same-line.test.js`, "the comment above must lose to
 * the own line"). The rule: for each maximal run ending at L (exclusive
 * `runEnd`), when `lines[runEnd]` is an example line carrying an
 * `@intent: {` payload, flag ONLY the run's LAST line. The stacked arm
 * already flags all-but-last of a ≥2 run whenever an example follows, so
 * flagging only the last line here keeps the arms disjoint and every dead
 * line flagged exactly once. The separated arm requires a blank/comment
 * right after the run and this one requires the example there, so those two
 * are disjoint by construction as well.
 *
 * What counts as an "example line" in every arm above is ONE recognition
 * rule (EXAMPLE_CALL_SOURCE), not an enumerated list: a call head
 * (`it`/`test`/`specify`/`xit`/`fit`/`xtest`) plus any modifier chain, so the
 * three example-anchored arms and the group arm's one-liner exemption cannot
 * drift apart (SPGD-1568).
 *
 * Known heuristic limits, mirrored honestly from the Ruby twin's comments
 * (scanner.rb `GROUP_LINE` / `INTENT_WITH_PAYLOAD` / `EXAMPLE_ON_LINE`): the group selector keys on the keyword at line
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
 * ONE shared source for "this text opens an example call" — the anchor for
 * the stacked / separated / own-line-shadow arms (`EXAMPLE_LINE`) AND the
 * group arm's one-liner exemption (`EXAMPLE_ON_LINE`) are both built from it,
 * so the two can never drift (SPGD-1568: they did, and the narrow vocabulary
 * false-greened the first three arms and false-redded the fourth).
 *
 * The RULE, not a list: a call head — `it`, `test`, `specify`, or the Jest
 * aliases `xit`, `fit`, `xtest` — that is not the prefix of a longer
 * identifier (`item(`, `testing(`, `itinerary(` are not examples), followed by
 * any chain of `.identifier` segments, each optionally carrying its own
 * parenthesised arguments or a tagged template (`.each([1])`, `.skipIf(c)`,
 * `.each\`a|b\``), up to the call paren itself. So `it.only(`,
 * `it.concurrent(`, `it.skip.each([1])(`, `test.concurrent.only(` and
 * `it.runIf(c)(` all open an example without anyone enumerating them. A
 * chain whose tagged template is still open at the end of the line
 * (`test.each\``, the multi-line table form) opens one too. Parenthesised
 * arguments are balanced to a bounded depth (CALL_ARGS_DEPTH); a deeper
 * nesting on the head line is not recognised — a missed flag, never a false
 * one. Group keywords stay `GROUP_LINE`'s: `describe|suite|context` are not
 * heads here.
 */
const CALL_ARGS_DEPTH = 4;
const CALL_ARGS = (() => {
  let inner = "[^()]";
  for (let d = 0; d < CALL_ARGS_DEPTH; d += 1) inner = `(?:[^()]|\\(${inner}*\\))`;
  return `\\(${inner}*\\)`;
})();
const CALL_TEMPLATE = "`[^`]*`";
const CALL_SEGMENT = `\\.[A-Za-z_$][\\w$]*(?:${CALL_ARGS}|${CALL_TEMPLATE})?`;
const CALL_HEAD = "(?:it|test|specify|xit|fit|xtest)(?![\\w$])";
const EXAMPLE_CALL_SOURCE =
  `${CALL_HEAD}(?:(?:${CALL_SEGMENT})*\\s*\\(|(?:${CALL_SEGMENT})+\\s*\`[^\`]*$)`;

/**
 * The line an annotation run may be claimed from: an example call at the
 * start of a line. The TS analogue of the Ruby twin's `EXAMPLE_LINE`; the
 * call vocabulary is EXAMPLE_CALL_SOURCE's rule (runner modifiers, `.each`
 * tables, `.skipIf(c)` conditionals, `xit`/`fit` aliases).
 */
const EXAMPLE_LINE = new RegExp(`^\\s*${EXAMPLE_CALL_SOURCE}`);

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

/** Why a separated annotation fails: one intervening blank/comment line puts
 * the example out of the one-line lookback's reach. */
const UNREACHABLE_SEPARATED_ANNOTATION =
  "unreachable annotation: this @intent: is separated from its test by an intervening " +
  "comment or blank line, and the one-line lookback claims only the line directly above " +
  "the test — this annotation is discarded at extraction (SPGD-12 §2). Move it to " +
  "directly above the test (or merge it into the line that is)";

/** Why a shadowed comment fails: the example's own-line `@intent:` wins under
 * own-line-first extraction, so the comment line directly above is discarded. */
const UNREACHABLE_OWN_LINE_SHADOW =
  "unreachable annotation: the test below carries its own trailing @intent:, and " +
  "extraction is own-line-first (SPGD-12 §2) — that own-line annotation wins, so this " +
  "comment line is discarded and no test can ever claim it. Delete it, or merge its " +
  "behavior into the trailing @intent:";

/** A blank (whitespace-only) line — one of the two interleaves the separated arm reads. */
const BLANK_LINE = /^\s*$/;

/** A comment-only line (`//`-leading) — the TS analogue of annotate.ts's
 * `COMMENT_ONLY_LINE`; the separated arm reads it only when it carries no
 * `@intent:` token. */
const COMMENT_ONLY_LINE = /^\s*\/\//;

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
 * `INTENT_WITH_PAYLOAD` (scanner.rb). The `{` is load-bearing:
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
 * `EXAMPLE_ON_LINE` (scanner.rb): a group line that ALSO opens an
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
const EXAMPLE_ON_LINE = new RegExp(`(?:\\{|;)\\s*${EXAMPLE_CALL_SOURCE}`);

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
 * The separated findings for one file's source text, in line order: EVERY
 * line of a comment-form `@intent:` run (nothing in it is claimed) whose
 * following line is blank or a non-`@intent` comment and whose line after
 * that is an example line.
 */
export function separatedFindingsInText(text: string, file: string): LintFinding[] {
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
    const runEnd = i; // exclusive; lines[runEnd] is the interleave candidate

    const between = lines[runEnd];
    const example = lines[runEnd + 1];
    if (
      between !== undefined &&
      example !== undefined &&
      (BLANK_LINE.test(between) || (COMMENT_ONLY_LINE.test(between) && !COMMENT_INTENT_LINE.test(between))) &&
      EXAMPLE_LINE.test(example)
    ) {
      for (let j = runStart; j < runEnd; j += 1) {
        findings.push({
          file,
          line: j + 1,
          kind: "unreachable",
          ok: false,
          errors: [UNREACHABLE_SEPARATED_ANNOTATION],
          intent: null,
          aboutFile: false,
        });
      }
    }
  }

  return findings;
}

/**
 * The own-line-shadow findings for one file's source text, in line order:
 * for each maximal comment-form `@intent:` run whose immediately-following
 * line is an example line that itself carries an `@intent: {` payload, ONE
 * finding on the run's LAST line (the line the lookback would have claimed
 * had the example no annotation of its own). Earlier lines of a ≥2 run are
 * the stacked arm's.
 */
export function ownLineShadowFindingsInText(text: string, file: string): LintFinding[] {
  const lines = text.split("\n");
  const findings: LintFinding[] = [];
  let i = 0;

  while (i < lines.length) {
    if (!COMMENT_INTENT_LINE.test(lines[i]!)) {
      i += 1;
      continue;
    }

    i += 1;
    while (i < lines.length && COMMENT_INTENT_LINE.test(lines[i]!)) {
      i += 1;
    }
    const runEnd = i; // exclusive; lines[runEnd] is the candidate example

    const example = lines[runEnd];
    if (example !== undefined && EXAMPLE_LINE.test(example) && INTENT_WITH_PAYLOAD.test(example)) {
      findings.push({
        file,
        line: runEnd, // 1-based number of lines[runEnd - 1], the run's last line
        kind: "unreachable",
        ok: false,
        errors: [UNREACHABLE_OWN_LINE_SHADOW],
        intent: null,
        aboutFile: false,
      });
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
    // Ruby parity (scanner.rb `unreachable_findings_in_text`, four arms, all
    // mirrored in Ruby; the separated and own-line-shadow arms originated in
    // TS, SPGD-1550/1556, mirrored in SPGD-1554/1560): the
    // arms are disjoint by construction — the stacked pass reads only
    // `//`-leading comment lines and needs an example at the run's end
    // (flagging all but the run's last line), the own-line-shadow pass reads
    // the same runs and example but flags ONLY the run's last line, and only
    // when that example carries its own payload, the separated pass needs a
    // blank/comment right after the run, the group pass only lines that are
    // not `//`-leading — so the merge cannot double-flag a line, and the per-file sort restores the
    // file-then-line order `unreachableFindings` promises. (`?? 0` is a type
    // accommodation only — ValidatorFinding.line is nullable for binary rows,
    // but every arm above always emits a 1-based line.)
    const perFile = [
      ...stackedFindingsInText(text, file),
      ...separatedFindingsInText(text, file),
      ...ownLineShadowFindingsInText(text, file),
      ...groupLineFindingsInText(text, file),
    ];
    perFile.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    findings.push(...perFile);
  }
  return findings;
}
