/**
 * Derives a Jest test's line number from its suite's SOURCE when Jest itself
 * reported none (`testLocationInResults` off, so every `location` is null).
 *
 * The reporter cannot switch the option on — Jest 30 hands it a frozen
 * `globalConfig` — so the line is recovered the only other way: scan the test
 * file for the `it(` / `test(` call whose first string-literal argument is the
 * assertion's `title`. This is a HEURISTIC, not a parser:
 *
 *   - Titles that are not a plain string literal (templated `it.each` titles
 *     with `%s` placeholders, computed titles, concatenations) match nothing.
 *   - A commented-out call on its own `//` line is skipped; a call inside a
 *     block comment or a string is not detected as such.
 *   - Matching is by leaf title only (ancestors are ignored), so repeated
 *     titles are matched to successive occurrences in the order Jest reports
 *     them — first-unconsumed wins.
 *
 * A caller that gets `null` falls back to line `1` (the convention
 * `fileFailedRow` already uses) rather than dropping the row. Nothing here
 * throws.
 */

/** Identifier (+ optional `.only`/`.skip`/`.concurrent`… chain) then `(` and the first argument's opening quote. */
const CALL = /(?<![\w$.])(?:it|test|fit|xit|xtest)((?:\.[A-Za-z]+)*)\s*\(\s*(["'`])/g;

/** Modifier chains whose call is NOT a single test with a literal title. */
const NON_LITERAL_MODIFIERS = new Set(["each"]);

interface Occurrence {
  title: string;
  line: number;
}

/** Read one string literal starting just AFTER its opening quote; null when unterminated or interpolated. */
function readLiteral(source: string, start: number, quote: string): string | null {
  let out = "";
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]!;
    if (ch === "\\") {
      const next = source[i + 1];
      if (next === undefined) return null;
      out += next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next;
      i += 1;
      continue;
    }
    if (ch === quote) return out;
    if (quote === "`" && ch === "$" && source[i + 1] === "{") return null;
    if (ch === "\n" && quote !== "`") return null;
    out += ch;
  }
  return null;
}

/** Every literal-titled test call in `source`, in source order, with its 1-based call line. */
export function scanTestCalls(source: string): Occurrence[] {
  const found: Occurrence[] = [];
  CALL.lastIndex = 0;
  let line = 1;
  let cursor = 0;
  for (let m = CALL.exec(source); m !== null; m = CALL.exec(source)) {
    // Advance the running line count incrementally: one pass over the source.
    for (; cursor < m.index; cursor += 1) {
      if (source.charCodeAt(cursor) === 10) line += 1;
    }
    const modifiers = (m[1] ?? "").split(".").filter((s) => s !== "");
    if (modifiers.some((s) => NON_LITERAL_MODIFIERS.has(s))) continue;
    const lineStart = source.lastIndexOf("\n", m.index - 1) + 1;
    if (source.slice(lineStart, m.index).includes("//")) continue; // commented out
    const title = readLiteral(source, m.index + m[0].length, m[2]!);
    if (title === null) continue;
    found.push({ title, line });
  }
  return found;
}

/**
 * The per-suite line source: hands out, for each title, the successive
 * occurrences of that title in the file. Built once per suite from the file's
 * text (`null` text = unreadable file, every lookup yields `null`).
 */
export class SourceLineIndex {
  private readonly byTitle = new Map<string, number[]>();

  constructor(source: string | null) {
    if (source === null) return;
    try {
      for (const { title, line } of scanTestCalls(source)) {
        const lines = this.byTitle.get(title);
        if (lines === undefined) this.byTitle.set(title, [line]);
        else lines.push(line);
      }
    } catch {
      this.byTitle.clear(); // a scan failure derives nothing; every row falls back
    }
  }

  /** The next unconsumed line for `title`, or null when none remains. */
  take(title: string): number | null {
    const lines = this.byTitle.get(title);
    if (lines === undefined || lines.length === 0) return null;
    return lines.shift() ?? null;
  }
}
