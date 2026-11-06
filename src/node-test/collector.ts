import { relative, isAbsolute, sep } from "node:path";
import type { SpecRow } from "../core/types.js";
import { exampleId } from "../core/id.js";
import { fileFailedRow } from "../core/file-failed.js";
import { msToSeconds } from "../core/duration.js";

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
  /** Files that already shipped a failed row of their own. */
  private readonly filesWithFailedRow = new Set<string>();
  /**
   * Files with a failed SUITE that had no failed row at the time it closed,
   * mapped to that suite's duration (ms). Resolved lazily by `getRows()`:
   * a later test in the same file may still fail on its own, and the file
   * then already has its failed row, so deciding at suite-close would
   * double-count it.
   */
  private readonly pendingSuiteFailures = new Map<string, number | undefined>();
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
   * the stack but never produce a row of their own — otherwise a failing
   * child is reported twice, once as itself and once through its parent
   * suite. A FAILED suite none of whose descendants failed (a throwing
   * `after()` / `before()` hook) is the one exception: it is remembered
   * and, if its file still has no failed row at the end, ships as the
   * file's ONE failed row (see `getRows`).
   */
  onResult(data: TestEventData, kind: "pass" | "fail"): void {
    const top = this.stack.pop();

    if (data.details?.type === "suite") {
      // A suite result closes the suite frame. Suites at the top of the
      // stack pop cleanly (LIFO); tolerate a mismatched pop so a surprising
      // stream can never throw.
      if (kind === "fail") this.onSuiteFailed(data);
      return;
    }

    if (top === undefined) return;

    const file = data.file;
    const line = data.line;

    // A test FILE is reported as an event of its own: a file with zero tests
    // emits one synthetic pass (not a test — must not ship), and a file that
    // failed to run at all (syntax error, throwing top-level statement,
    // missing import) emits a fail. The event's name is the absolute path on
    // Node 20 and a cwd-relative path on newer Node, so it is recognised
    // against both spellings.
    if (this.isFileLevelEvent(data.name, file)) {
      if (kind === "fail") this.onFileFailed(data);
      return;
    }

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
    // node reports MILLISECONDS.
    const duration = msToSeconds(durationMs);

    // A skipped test emits test:pass with skip: true — it is deliberately
    // shipped with outcome "pending", never silently counted as a pass.
    const outcome = kind === "fail" ? "failed" : data.skip === true ? "pending" : "passed";

    if (outcome === "failed") this.filesWithFailedRow.add(filePath);
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

  /**
   * A file-level `test:fail`: the file crashed before (or instead of) running
   * its tests. Ships ONE row with a stable machine-independent name — unless
   * the file already produced a failed row of its own, in which case the
   * file's failure is already represented and a second row would double-count.
   */
  private onFileFailed(data: TestEventData): void {
    const file = data.file;
    if (typeof file !== "string" || file === "") {
      this.dropped += 1;
      return;
    }
    const filePath = this.relativize(file);
    if (this.filesWithFailedRow.has(filePath)) return;
    const durationMs = data.details?.duration_ms;
    const duration = msToSeconds(durationMs);
    this.filesWithFailedRow.add(filePath);
    this.rows.push(fileFailedRow(filePath, duration));
  }

  /**
   * A failed `describe`. Its failing children, if any, closed (and shipped
   * their rows) before it did, so a suite failure that finds a failed row for
   * its file is already represented. Otherwise it is a hook failure; park it
   * until `getRows()` can tell whether a later test in the file failed.
   */
  private onSuiteFailed(data: TestEventData): void {
    const file = data.file;
    if (typeof file !== "string" || file === "") return; // not attributable to a file; the run is still red in node's own output
    const filePath = this.relativize(file);
    if (this.filesWithFailedRow.has(filePath) || this.pendingSuiteFailures.has(filePath)) return;
    this.pendingSuiteFailures.set(filePath, data.details?.duration_ms);
  }

  /**
   * True when the event is the runner's own event for the test FILE rather
   * than for a test in it: the name is the file's path, spelled absolutely
   * (Node 20) or relative to the working directory (newer Node).
   */
  private isFileLevelEvent(name: string | undefined, file: string | undefined): boolean {
    if (name === undefined || typeof file !== "string" || file === "") return false;
    if (name === file) return true;
    for (const root of [process.cwd(), this.repoRoot]) {
      const rel = relative(root, file);
      if (name === rel || name === rel.split(sep).join("/")) return true;
    }
    return false;
  }

  getRows(): readonly SpecRow[] {
    this.resolveSuiteFailures();
    return this.rows;
  }

  /** Ship one file row per parked suite failure whose file still has no failed row. Idempotent. */
  private resolveSuiteFailures(): void {
    for (const [filePath, durationMs] of this.pendingSuiteFailures) {
      if (this.filesWithFailedRow.has(filePath)) continue;
      const duration = msToSeconds(durationMs);
      this.filesWithFailedRow.add(filePath);
      this.rows.push(fileFailedRow(filePath, duration));
    }
    this.pendingSuiteFailures.clear();
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
