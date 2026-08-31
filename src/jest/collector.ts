import { relative, isAbsolute, sep } from "node:path";
import type { SpecRow } from "../core/types.js";
import { exampleId } from "../core/id.js";

/**
 * Structural types for the Jest 30 reporter API this collector reads —
 * `onRunComplete`'s aggregated `results`. Declared here, not imported from
 * `@jest/reporters` or `jest`, because Jest is an OPTIONAL peer: this
 * package must stay installable in a `node:test` or Vitest project with no
 * Jest present, and a type-only import would still fail this repo's own
 * `tsc --noEmit` (no Jest is installed here). Only the members this
 * collector consumes are declared, exactly like `TestEventData` in
 * `src/node-test/collector.ts` and the Vitest types beside this one.
 *
 * Measured against Jest 30.5 (see test/integration.jest.test.ts, which pins
 * every one of these facts against a real `jest` child process):
 *
 *   - Jest constructs the reporter with THREE arguments —
 *     `(globalConfig, options, docs)` — so the adapter's options are the
 *     SECOND constructor parameter. (Vitest measured ONE options object;
 *     neither shape may be assumed, each was measured.)
 *   - `location.line` is 1-based and points at the `it(` CALL line — the
 *     same anchor `node:test` and Vitest report — but ONLY when the Jest
 *     config sets `testLocationInResults: true`; without it `location`
 *     is null and every row must drop.
 *   - Per-test `duration` is MILLISECONDS and EXISTS (Jest's ancestors
 *     reported durations only at suite level); skip-family tests carry
 *     `duration: null`.
 *   - `it.skip` surfaces as status `"pending"` and `it.todo` as `"todo"`
 *     — both skip-family, shipped with the wire's outcome `"pending"`.
 *     `it.concurrent` surfaces as an ordinary `"passed"`/`"failed"` row.
 *   - `fullName` joins ancestry with a SINGLE SPACE (`"outer inner test"`)
 *     — a separator no other adapter produces — so the composed name is
 *     RECOMPOSED from `ancestorTitles` + `title` with the `" > "` join
 *     both existing adapters emit. `fullName` is never read.
 *   - The suite's `testFilePath` is an absolute path; the collector
 *     relativizes it against the repo root itself, mirroring the other
 *     two collectors.
 *   - Jest AWAITS an async `onRunComplete`, and a hook that THROWS fails
 *     an otherwise passing run (measured: exit 1, the throw surfaces as
 *     the CLI error) — the reporter's guards are load-bearing.
 */

/** The structural subset of Jest's per-test `AssertionResult` this collector reads. */
export interface JestAssertionResult {
  /** The leaf test's own title, never ancestry-prefixed. */
  title?: string | undefined;
  /** Space-joined ancestry + title — DIVERGENT; recomposed instead. */
  fullName?: string | undefined;
  /** The open `describe` titles, outermost first. */
  ancestorTitles?: readonly string[] | undefined;
  /** Null unless the Jest config sets `testLocationInResults: true`. */
  location?: { line: number; column: number } | null | undefined;
  /** "passed" | "failed" | "pending" | "todo" (measured; skip-family below). */
  status?: string | undefined;
  /** Milliseconds. Null on skip-family tests. */
  duration?: number | null | undefined;
}

/** The structural subset of Jest's per-suite `TestResult` this collector reads. */
export interface JestSuiteResult {
  /** Usually an absolute file path. */
  testFilePath?: string | undefined;
  testResults?: readonly JestAssertionResult[] | undefined;
}

/** The structural subset of Jest's aggregated `AggregatedResult` this collector reads. */
export interface JestRunResult {
  testResults?: readonly JestSuiteResult[] | undefined;
}

/**
 * Turns a Jest 30 `onRunComplete` aggregated result into per-example rows.
 *
 * Where the node:test collector reconstructs composed names from a
 * start/result stack (that runner's stream carries no ancestry) and the
 * Vitest collector reads each finished case's `fullName`, Jest hands the
 * ancestry as a LIST (`ancestorTitles`) with a `fullName` that joins it
 * with spaces — so this collector recomposes the SAME `"outer > inner >
 * test"` string the other two produce from the parts, and never trusts
 * Jest's own composition. The row shape, the id composition, the seconds
 * conversion at the edge, and the dropped-row discipline are byte-identical
 * to the other collectors': same wire, same rules.
 */
export class JestCollector {
  private readonly rows: SpecRow[] = [];
  private readonly startedAtMs: number;
  private readonly repoRoot: string;
  /** Rows dropped for a missing/invalid line, name, or outcome — warned once at the end. */
  dropped = 0;

  constructor(repoRoot: string, startedAtMs: number = Date.now()) {
    this.repoRoot = repoRoot;
    this.startedAtMs = startedAtMs;
  }

  /** Consume one `onRunComplete` aggregated result. Never throws. */
  onRunComplete(results: unknown): void {
    let suites: readonly unknown[] = [];
    try {
      const aggregated = results as JestRunResult | null | undefined;
      const list = aggregated?.testResults;
      suites = Array.isArray(list) ? list : [];
    } catch {
      return; // a hostile results object never fails the run
    }
    for (const suite of suites) {
      let assertions: readonly unknown[] = [];
      let filePathRaw: unknown;
      try {
        const s = suite as JestSuiteResult | null | undefined;
        filePathRaw = s?.testFilePath;
        const list = s?.testResults;
        assertions = Array.isArray(list) ? list : [];
      } catch {
        continue;
      }
      for (const assertion of assertions) {
        try {
          this.add(filePathRaw, assertion);
        } catch {
          this.dropped += 1;
        }
      }
    }
  }

  getRows(): readonly SpecRow[] {
    return this.rows;
  }

  durationSeconds(nowMs: number = Date.now()): number {
    return Math.max(0, (nowMs - this.startedAtMs) / 1000);
  }

  private add(filePathRaw: unknown, assertion: unknown): void {
    const file = typeof filePathRaw === "string" ? filePathRaw : undefined;
    const test = assertion as JestAssertionResult | null | undefined;

    // line_number must be a positive integer or the whole payload is refused
    // per-spec; dropping the row (and saying so) beats a rejected payload.
    // On Jest the overwhelmingly common cause is a config without
    // `testLocationInResults: true`, so the reporter's warning names it.
    const line = test?.location?.line;
    if (
      typeof file !== "string" ||
      file === "" ||
      typeof line !== "number" ||
      !Number.isInteger(line) ||
      line <= 0
    ) {
      this.dropped += 1;
      return;
    }

    // The composed name is RECOMPOSED from ancestorTitles + title: Jest's
    // own fullName joins with a single space ("outer inner test"), a
    // separator no other adapter emits, and cross-runner row-name
    // consistency is a deliberate uniform contract. The TITLE is the
    // leaf's identity — required — while ancestors only decorate it: a
    // row named from ancestors alone would misattribute every sibling
    // to one id, so a missing title drops the row however many
    // ancestors arrived.
    const title = test?.title;
    if (typeof title !== "string" || title === "") {
      this.dropped += 1;
      return;
    }
    const ancestors = Array.isArray(test?.ancestorTitles) ? test.ancestorTitles : [];
    const name = [
      ...ancestors.filter((a) => typeof a === "string" && a !== ""),
      title,
    ].join(" > ");
    const status = test?.status;
    if (status !== "passed" && status !== "failed") {
      if (status === "pending" || status === "todo" || status === "skipped" || status === "disabled") {
        // Skip-family: it.skip surfaces as "pending", it.todo as "todo" —
        // deliberately shipped with outcome "pending", never silently a pass.
      } else {
        // Anything unrecognized is not a result; drop rather than guess.
        this.dropped += 1;
        return;
      }
    }

    const durationMs = test?.duration;
    const duration =
      typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
        ? durationMs / 1000 // the wire field is SECONDS; Jest reports MILLISECONDS
        : null; // skip-family tests carry duration null — never fabricate

    const outcome =
      status === "failed" ? "failed" : status === "passed" ? "passed" : "pending";

    const filePath = this.relativize(file);
    this.rows.push({
      file_path: filePath,
      line_number: line,
      status: "unannotated",
      intent: null,
      name,
      duration,
      id: exampleId(filePath, name),
      outcome,
    });
  }

  private relativize(file: string): string {
    if (!isAbsolute(file)) return file.split(sep).join("/");
    const rel = relative(this.repoRoot, file);
    // A file outside the repo root keeps its absolute path rather than a
    // nonsense ../ escape.
    if (rel.startsWith("..") || isAbsolute(rel)) return file;
    return rel.split(sep).join("/");
  }
}
