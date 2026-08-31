import { JestCollector } from "./collector.js";
import { annotateRows } from "../node-test/annotate.js";
import { buildEnvelope } from "../core/envelope.js";
import { readRunnerEnv, type RunnerEnv } from "../core/env.js";
import { deliver, type TransportDeps } from "../core/transport.js";
import type { ValidatorDeps } from "../core/validator.js";

export { JestCollector } from "./collector.js";
export type {
  JestAssertionResult,
  JestSuiteResult,
  JestRunResult,
} from "./collector.js";

/** Injection seams for tests; a real Jest run needs none of them. */
export interface JestReporterOptions {
  /** Overrides the process environment (tests). */
  env?: RunnerEnv;
  /** Repo root for relativizing file paths (tests). Defaults to cwd. */
  repoRoot?: string;
  /** Transport injection (tests). */
  transport?: TransportDeps;
  /** Validator resolution injection for the annotation pass (tests). */
  validator?: ValidatorDeps;
}

/**
 * The Jest reporter — the third adapter on the unchanged runner-agnostic
 * core: everything here is core calls plus the Jest-result mapping in
 * `JestCollector`.
 *
 * Configure it beside the default reporter:
 *
 *   // jest.config.mjs
 *   export default {
 *     reporters: ["default", "specguard-ts/jest"],
 *     testLocationInResults: true, // without this Jest reports no lines
 *   };
 *
 * Jest constructs this class with THREE arguments —
 * `(globalConfig, options, docs)`, measured on Jest 30 — so the adapter's
 * options are the SECOND parameter (Vitest hands one options object; each
 * runner's shape was measured, neither assumed).
 *
 * Telemetry never fails the suite — the never-fail guarantee, verbatim
 * from the node:test and Vitest reporters and load-bearing here in Jest's
 * own way: Jest AWAITS an async `onRunComplete`, and a hook that throws
 * surfaces as the CLI error and fails an otherwise passing run (measured:
 * exit 1, pinned by test/integration.jest.test.ts). Every step is guarded,
 * a failed delivery costs one line on stderr and a line in the fallback
 * sink, and the delivery completes before the process exits because Jest
 * awaits the returned promise.
 */
export class SpecguardJestReporter {
  private readonly options: JestReporterOptions;
  private readonly env: RunnerEnv;
  private startedAtMs: number;

  constructor(
    _globalConfig?: unknown,
    options?: JestReporterOptions,
    ..._rest: unknown[]
  ) {
    // Jest instantiates this class with (globalConfig, options, docs) when
    // the reporter is named in the config; a user constructing it directly
    // passes the same options shape as the second argument. Neither
    // construction may ever throw.
    this.options =
      options !== null && typeof options === "object" ? options : ({} as JestReporterOptions);
    let env: RunnerEnv;
    try {
      env = this.options.env ?? readRunnerEnv();
    } catch {
      // readRunnerEnv never throws on its own; this is the backstop.
      env = {
        commitSha: null,
        branch: null,
        ciRunId: null,
        shardId: null,
        endpoint: null,
        apiKey: null,
        timeoutMs: 10_000,
        outputPath: "log/test_results.jsonl",
        localOutputPath: "log/test_results.local.jsonl",
      };
    }
    this.env = env;
    this.startedAtMs = Date.now();
  }

  /** Watch mode: each rerun is a run; its duration is measured from here. */
  onRunStart(_contexts?: unknown): void {
    this.startedAtMs = Date.now();
  }

  /**
   * Jest's run-end hook. Jest awaits the returned promise, so the delivery
   * completes before the process exits. NEVER THROWS — see the class doc;
   * the whole finish sequence is guarded, with the transport's own
   * never-throw discipline underneath.
   */
  async onRunComplete(_contexts: unknown, results: unknown): Promise<void> {
    try {
      const repoRoot = this.options.repoRoot ?? process.cwd();
      const collector = new JestCollector(repoRoot, this.startedAtMs);
      collector.onRunComplete(results);

      if (collector.dropped > 0) {
        process.stderr.write(
          `SpecGuard: dropped ${collector.dropped} test result(s) with no usable line or outcome — Jest reports test locations only with \`testLocationInResults: true\` in the Jest config. The test run is unaffected.\n`,
        );
      }

      // A run that reported zero tests has nothing to say — no POST, no file.
      const rows = collector.getRows();
      if (rows.length === 0) return;

      // The annotation pass is shared with the node:test and Vitest
      // adapters, unchanged: it never throws, never changes the exit code,
      // and on any failure the unannotated rows ship as-is.
      const annotated = annotateRows(rows, {
        repoRoot,
        ...this.options.validator,
      });

      const envelope = buildEnvelope(annotated.rows, this.env, collector.durationSeconds());
      if (envelope === null) {
        process.stderr.write(
          "SpecGuard: no commit sha could be resolved (set SPECGUARD_COMMIT_SHA); telemetry not sent. The test run is unaffected.\n",
        );
        return;
      }

      await deliver(envelope, this.env, this.options.transport);
    } catch {
      // The never-fail guarantee: nothing here reaches the exit code.
      process.stderr.write(
        "SpecGuard: the Jest reporter failed unexpectedly; telemetry not sent. The test run is unaffected.\n",
      );
    }
  }
}

export default SpecguardJestReporter;
