import { EXAMPLE_LINE } from "../lint/unreachable.js";

/**
 * Where does the example call a telemetry row belongs to OPEN?
 *
 * Vitest and Jest (`testLocationInResults`) report a parameterised test at the
 * line of its SECOND call — the closing `])("title", fn)` line of a multi-line
 * `it.each([ ... ])("title", fn)`, or the `` `("title", fn) `` line of a tagged
 * template table — not the line `it.each` opens on. An annotation above that
 * opener is several lines from the reported line, so the two lookup arms in
 * `annotateRows` (the row's own line, the comment-only line above it) cannot
 * reach it, while `specguard lint` (which recognises the opener through the
 * same `EXAMPLE_LINE`) calls it reachable. This helper closes the gap: it
 * resolves the opener from the reported line so the SAME two arms can be
 * applied there.
 *
 * Heuristic and never-throwing by construction: the extent scan understands
 * brackets, strings, comments and template literals (with `${}` nesting) but
 * not regex literals, and every uncertainty (unbalanced text, runaway scan,
 * no covering head) answers `null`, which the caller reads as "fall through to
 * the pre-existing behaviour".
 */

/** The most heads one resolution will weigh before giving up. */
const MAX_HEADS_EXAMINED = 200;
/** The longest statement (in lines) an extent scan will follow. */
const MAX_EXTENT_LINES = 5000;

/** Per-file cache of head line index → last line index of its statement
 * (`null` = the scan could not decide). Keyed by the `lines` array identity. */
const extentCache = new WeakMap<readonly string[], Map<number, number | null>>();

/**
 * 0-based index of the last line of the statement that begins at `start`, or
 * `null` when the text does not balance within the scan budget.
 *
 * The statement ends at the first moment every bracket / template opened since
 * `start` has closed AND the next significant character on that line is not the
 * start of another call segment (`(`, a tagged-template backtick, or `.`):
 * `it.each([...])("t", fn)` closes once at `])` — followed by `(`, so it goes on
 * — and once more at `fn)`.
 */
export function statementEndIndex(lines: readonly string[], start: number): number | null {
  // Stack entries: "(" "[" "{" — code brackets; "`" — inside template TEXT;
  // "${" — a `${ ... }` expression inside a template.
  const stack: string[] = [];
  const last = Math.min(lines.length, start + MAX_EXTENT_LINES);
  let inBlockComment = false;
  for (let li = start; li < last; li += 1) {
    const text = lines[li]!;
    let ci = 0;
    while (ci < text.length) {
      const ch = text[ci]!;
      const top = stack[stack.length - 1];
      if (inBlockComment) {
        const close = text.indexOf("*/", ci);
        if (close < 0) {
          ci = text.length;
        } else {
          inBlockComment = false;
          ci = close + 2;
        }
        continue;
      }
      if (top === "`") {
        if (ch === "\\") ci += 2;
        else if (ch === "`") {
          stack.pop();
          ci += 1;
          if (stack.length === 0 && !continuesCall(text, ci)) return li;
        } else if (ch === "$" && text[ci + 1] === "{") {
          stack.push("${");
          ci += 2;
        } else ci += 1;
        continue;
      }
      if (ch === "/" && text[ci + 1] === "/") break; // line comment: rest of line
      if (ch === "/" && text[ci + 1] === "*") {
        inBlockComment = true;
        ci += 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        // A string literal ends on its own line at the latest.
        let j = ci + 1;
        while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
        ci = j + 1;
        continue;
      }
      if (ch === "`") {
        stack.push("`");
        ci += 1;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") {
        stack.push(ch);
        ci += 1;
        continue;
      }
      if (ch === ")" || ch === "]" || ch === "}") {
        const open = stack.pop();
        const matches =
          (ch === ")" && open === "(") ||
          (ch === "]" && open === "[") ||
          (ch === "}" && (open === "{" || open === "${"));
        if (!matches) return null;
        ci += 1;
        if (stack.length === 0 && !continuesCall(text, ci)) return li;
        continue;
      }
      ci += 1;
    }
  }
  return null;
}

/** Whether the code right after `from` on this line carries on the call chain. */
function continuesCall(text: string, from: number): boolean {
  const rest = text.slice(from).trimStart();
  return rest.startsWith("(") || rest.startsWith("`") || rest.startsWith(".");
}

function extentOf(lines: readonly string[], head: number): number | null {
  let cache = extentCache.get(lines);
  if (cache === undefined) {
    cache = new Map();
    extentCache.set(lines, cache);
  }
  if (cache.has(head)) return cache.get(head) ?? null;
  const end = statementEndIndex(lines, head);
  cache.set(head, end);
  return end;
}

/**
 * The 1-based line of the example call that OPENS the statement `rowLine`
 * (1-based) sits inside, when that opener is a DIFFERENT line from `rowLine`.
 * `null` when `rowLine` is itself an opener (nothing new to try), when no
 * example head's extent reaches it, or on any scan failure.
 */
export function exampleOpenerLine(lines: readonly string[], rowLine: number): number | null {
  try {
    if (!Number.isInteger(rowLine) || rowLine < 2 || rowLine > lines.length) return null;
    // The reported line is a head itself: the own-line and line-above arms
    // already ran there.
    if (EXAMPLE_LINE.test(lines[rowLine - 1]!)) return null;
    let examined = 0;
    for (let i = rowLine - 2; i >= 0 && examined < MAX_HEADS_EXAMINED; i -= 1) {
      if (!EXAMPLE_LINE.test(lines[i]!)) continue;
      examined += 1;
      const end = extentOf(lines, i);
      if (end !== null && end >= rowLine - 1) return i + 1;
    }
    return null;
  } catch {
    return null;
  }
}
