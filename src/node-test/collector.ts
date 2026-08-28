import { relative, isAbsolute, sep } from "node:path";
import type { SpecRow } from "../core/types.js";
import { exampleId } from "../core/id.js";

/**
 * The shape of `ev.data` on the `node:test` reporter events this collector
 * reads. Only the fields this client consumes are declared.
 */
export interface TestEventData {
  type?: string;
  name?: string;
  nesting?: number;
  file?: string;
  line?: number;
  column?: number;
  skip?: boolean | undefined;
  todo?: boolean | undefined;
  details?: {
    type?: string | undefined;
    duration_ms?: number | undefined;
  } | undefined;
}

/** An open `describe` (or a leaf test between its start and its result). */
interface Frame {
  name: string;
  nesting: number;
}

/**
 * Turns a `node:test` reporter event stream into per-example rows.
 *
 * The event stream carries no ancestry — only the leaf `name` and a `nesting`
 * integer — so the composed name (identity on the platform is semantic,
 * derived from the text, and a bare leaf like "works" is not distinguishing)
 * is reconstructed from a stack: every `test:start` pushes a frame, every
 * `test:pass` / `test:fail` pops the frame it belongs to, and the frames
 * still open below a leaf test are exactly its open suites. This relies on
 * suites closing in strict LIFO order (measured, and pinned by a test in
 * test/collector.test.ts, because it is an observed behaviour rather than a
 * documented guarantee).
 */
export class RunCollector {
  private readonly rows: SpecRow[] = [];
  private readonly stack: Frame[] = [];
  private readonly startedAtMs: number;
  private readonly repoRoot: string;
  /** Rows dropped for a missing/invalid line or file — warned once at the end. */
  dropped = 0;

  constructor(repoRoot: string, startedAtMs: number = Date.now()) {
    this.repoRoot = repoRoot;
    this.startedAtMs = startedAtMs;
  }

  onStart(data: TestEventData): void {
    this.stack.push({ name: data.name ?? "", nesting: data.nesting ?? 0 });
  }

  /**
   * Handle a `test:pass` or `test:fail` event. `describe` blocks emit their
   * own pass/fail events (`details.type === "suite"`); they are popped from
   * the stack but never produce a row — otherwise a failing child is
   * reported twice, once as itself and once through its parent suite.
   */
  onResult(data: TestEventData, kind: "pass" | "fail"): void {
    const top = this.stack.pop();

    if (data.details?.type === "suite") {
      // A suite result closes the suite frame. Suites at the top of the
      // stack pop cleanly (LIFO); tolerate a mismatched pop so a surprising
      // stream can never throw.
      return;
    }

    if (top === undefined) return;

    const file = data.file;
    const line = data.line;

    // A file that reports zero tests still emits one synthetic pass event
    // FOR THE FILE ITSELF — name is the absolute path, line 1. It is not a
    // test and must not ship as one.
    if (data.name !== undefined && data.name === file) return;

    const composedName = [...this.stack.map((f) => f.name), top.name]
      .filter((segment) => segment !== "")
      .join(" > ");
    // line_number must be a positive integer or the whole payload is refused
    // per-spec; dropping the row (and saying so) beats a rejected payload.
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

    const filePath = this.relativize(file);
    const durationMs = data.details?.duration_ms;
    const duration =
      typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
        ? durationMs / 1000 // the wire field is SECONDS; node reports MILLISECONDS
        : null;

    // A skipped test emits test:pass with skip: true — it is deliberately
    // shipped with outcome "pending", never silently counted as a pass.
    const outcome = kind === "fail" ? "failed" : data.skip === true ? "pending" : "passed";

    this.rows.push({
      file_path: filePath,
      line_number: line,
      status: "unannotated",
      intent: null,
      name: composedName,
      duration,
      id: exampleId(filePath, composedName),
      outcome,
    });
  }

  getRows(): readonly SpecRow[] {
    return this.rows;
  }

  durationSeconds(nowMs: number = Date.now()): number {
    return Math.max(0, (nowMs - this.startedAtMs) / 1000);
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
