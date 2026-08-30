import { relative, isAbsolute, sep } from "node:path";
import type { SpecRow } from "../core/types.js";
import { exampleId } from "../core/id.js";

/**
 * Structural types for the Vitest 4 reporter API this collector reads —
 * `onTestRunEnd`'s `TestModule[]`. Declared here, not imported from
 * `vitest/node`, because Vitest is an OPTIONAL peer: this package must stay
 * installable in a `node:test` project with no Vitest present, and a
 * type-only import would still fail this repo's own `tsc --noEmit` (no
 * Vitest is installed here). Only the members this collector consumes are
 * declared, exactly like `TestEventData` in `src/node-test/collector.ts`.
 *
 * Measured against Vitest 4.1 (see test/integration.vitest.test.ts, which
 * pins every one of these facts against a real `vitest run` child process):
 *
 *   - `onTestRunEnd` REPLACED Vitest ≤3's `onFinished`; the old hook never
 *     fires on Vitest 4, so this adapter targets Vitest >= 4 only.
 *   - `location.line` is 1-based and points at the `test(` CALL line — the
 *     same anchor `node:test` reports — but ONLY when the Vitest config sets
 *     `includeTaskLocation: true`; without it `location` is null.
 *   - `diagnostic().duration` is MILLISECONDS and is ABSENT on skipped
 *     tests (no diagnostic at all).
 *   - `result().state` is "passed" | "failed" | "skipped" | "pending";
 *     both `test.skip` and `test.todo` surface as "skipped" (distinguished
 *     only by `options.mode`, which the wire's three outcome words do not
 *     need — both ship as "pending", the Ruby client's word).
 *   - `fullName` is the composed "outer suite > inner suite > test" string
 *     with the module path already excluded — the same composition the
 *     node:test collector reconstructs from a stack.
 *   - `moduleId` is an absolute path; the collector relativizes it against
 *     the repo root itself, mirroring the node:test collector.
 */
export interface VitestTestDiagnostic {
  /** Milliseconds. Absent entirely on skipped tests. */
  duration?: number | undefined;
}

export interface VitestTestResult {
  state?: string | undefined;
}

/** The structural subset of Vitest 4's `TestCase` this collector reads. */
export interface VitestTestCase {
  type?: string | undefined;
  name?: string | undefined;
  /** "outer > inner > test" — module path excluded. */
  fullName?: string | undefined;
  /** Null unless the Vitest config sets `includeTaskLocation: true`. */
  location?: { line: number; column: number } | null | undefined;
  result?: (() => VitestTestResult | null | undefined) | null | undefined;
  diagnostic?: (() => VitestTestDiagnostic | null | undefined) | null | undefined;
}

/** The structural subset of Vitest 4's `TestModule` this collector reads. */
export interface VitestTestModule {
  type?: string | undefined;
  /** Usually an absolute file path. */
  moduleId?: string | undefined;
  children?: {
    /** Yields every test recursively, suites not included. */
    allTests?: (state?: unknown) => Iterable<VitestTestCase> | null | undefined;
  } | null | undefined;
}

/**
 * Turns a Vitest 4 `onTestRunEnd` module list into per-example rows.
 *
 * Where the node:test collector reconstructs composed names from a
 * start/result stack (that runner's stream carries no ancestry), Vitest
 * hands the finished tree directly, so this collector walks finished test
 * cases and reads each one's `fullName` — the same composed-name contract,
 * arrived at from the other direction. The row shape, the id composition,
 * the seconds conversion at the edge, and the dropped-row discipline are
 * byte-identical to the node:test collector's: same wire, same rules.
 */
export class VitestCollector {
  private readonly rows: SpecRow[] = [];
  private readonly startedAtMs: number;
  private readonly repoRoot: string;
  /** Rows dropped for a missing/invalid line, name, or outcome — warned once at the end. */
  dropped = 0;

  constructor(repoRoot: string, startedAtMs: number = Date.now()) {
    this.repoRoot = repoRoot;
    this.startedAtMs = startedAtMs;
  }

  /** Consume one `onTestRunEnd` module list. Never throws. */
  onTestRunEnd(modules: readonly unknown[]): void {
    for (const mod of modules) {
      let tests: VitestTestCase[] = [];
      try {
        const iterable = readModuleChildren(mod)?.allTests?.();
        tests = iterable === null || iterable === undefined ? [] : [...iterable];
      } catch {
        continue; // a surprising module never fails the run
      }
      for (const test of tests) {
        try {
          this.add(mod, test);
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

  private add(mod: unknown, test: VitestTestCase): void {
    const file = readModuleId(mod);

    // line_number must be a positive integer or the whole payload is refused
    // per-spec; dropping the row (and saying so) beats a rejected payload.
    // On Vitest the overwhelmingly common cause is a config without
    // `includeTaskLocation: true`, so the reporter's warning names it.
    const line = test.location?.line;
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

    const fullName = test.fullName;
    const name =
      typeof fullName === "string" && fullName !== ""
        ? fullName
        : typeof test.name === "string" && test.name !== ""
          ? test.name
          : undefined;
    // `name` is required when intent is null (the wire contract); a row
    // with nothing to represent it cannot ship.
    if (name === undefined) {
      this.dropped += 1;
      return;
    }

    let state: string | undefined;
    try {
      state = test.result?.()?.state;
    } catch {
      state = undefined;
    }
    if (state !== "passed" && state !== "failed" && state !== "skipped") {
      // "pending" (never finished — an interrupted run) and anything
      // unrecognized are not results; drop rather than guess an outcome.
      this.dropped += 1;
      return;
    }

    let durationMs: number | undefined;
    try {
      durationMs = test.diagnostic?.()?.duration;
    } catch {
      durationMs = undefined;
    }
    const duration =
      typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
        ? durationMs / 1000 // the wire field is SECONDS; Vitest reports MILLISECONDS
        : null; // skipped tests carry no diagnostic — duration ships null

    // Both skip and todo surface as state "skipped" — deliberately shipped
    // with outcome "pending", never silently counted as a pass.
    const outcome = state === "failed" ? "failed" : state === "skipped" ? "pending" : "passed";

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

function readModuleId(mod: unknown): unknown {
  if (mod === null || typeof mod !== "object") return undefined;
  return (mod as { moduleId?: unknown }).moduleId;
}

function readModuleChildren(mod: unknown): VitestTestModule["children"] {
  if (mod === null || typeof mod !== "object") return undefined;
  return (mod as VitestTestModule).children;
}
