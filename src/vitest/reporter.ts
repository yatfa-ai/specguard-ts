import { VitestCollector } from "./collector.js";
import { readRunnerEnv, withNativeShard, type RunnerEnv } from "../core/env.js";
import { shipRun } from "../core/ship-run.js";
import type { TransportDeps } from "../core/transport.js";
import type { ValidatorDeps } from "../core/validator.js";

export { VitestCollector } from "./collector.js";
export type {
  VitestTestCase,
  VitestTestModule,
  VitestTestResult,
  VitestTestDiagnostic,
} from "./collector.js";

/** Injection seams for tests; a real Vitest run needs none of them. */
export interface VitestReporterOptions {
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
 * The Vitest reporter — slice 5's proof that the runner-agnostic core needs
 * no second runner's changes: everything here is core calls plus the
 * Vitest-event mapping in `VitestCollector`.
 *
 * Configure it as a module-path reporter (Vitest imports this module and
 * instantiates the default-exported class with an options object):
 *
 *   // vitest.config.ts
 *   import { defineConfig } from "vitest/config";
 *   export default defineConfig({
 *     test: {
 *       reporters: ["default", "@yatfa/specguard/vitest"],
 *     },
 *   });
 *
 * The reporter turns `includeTaskLocation` on itself in `onInit` (Vitest
 * reports no test lines without it, and the wire contract needs them), so
 * adding the reporter alone ships telemetry; setting the option by hand is
 * harmless. If the config cannot be flipped, rows are dropped with one
 * stderr warning instead.
 *
 * Requires Vitest >= 4.0.0: Vitest 4 replaced the reporter API this adapter
 * reads (`onTestRunEnd`; on Vitest <= 3 that hook does not exist and the old
 * `onFinished` hook fires instead — handled below with one loud warning, so
 * an old runner is a visible no-op rather than a silent one).
 *
 * Telemetry never fails the suite — the never-fail guarantee, verbatim from
 * the node:test reporter and load-bearing here too: a THROWING
 * `onTestRunEnd` surfaces in Vitest as an Unhandled Error and can fail an
 * otherwise passing run (measured, pinned by test/integration.vitest.test.ts).
 * Every step is guarded, a failed delivery costs one line on stderr and a
 * line in the local sink, and Vitest awaits this hook, so the process does
 * not exit mid-request.
 */
export class SpecguardVitestReporter {
  private readonly options: VitestReporterOptions;
  private env: RunnerEnv;
  private startedAtMs: number;

  constructor(options: VitestReporterOptions = {}) {
    // Vitest constructs this class with an (empty) options object when the
    // reporter is named as a path; a user constructing it directly passes
    // the same shape. Neither construction may ever throw.
    this.options =
      options !== null && typeof options === "object" ? options : ({} as VitestReporterOptions);
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
        repositoryId: null,
        timeoutMs: 10_000,
        outputPath: "log/test_results.jsonl",
        localOutputPath: "log/test_results.local.jsonl",
      };
    }
    this.env = env;
    this.startedAtMs = Date.now();
  }

  /**
   * Vitest's init hook, handed the Vitest instance. Its resolved config
   * carries `shard: { index, count }` only under `--shard=i/n`; the index
   * becomes the lowest-precedence `shard_id`. NEVER THROWS — an absent or
   * malformed shard leaves the env exactly as the constructor resolved it.
   *
   * It also enables `includeTaskLocation` on the resolved config: Vitest
   * leaves it off by default, and without it every test's `location` is
   * undefined so every row is dropped. This must happen here, not in the
   * constructor — the Vitest instance only exists in `onInit`. An explicit
   * `false` is indistinguishable from the default and is overridden; the
   * reporter's data is useless without lines. A frozen or odd config shape
   * falls through to the dropped-rows warning in `onTestRunEnd`.
   */
  onInit(vitest?: unknown): void {
    try {
      const config = (
        vitest as { config?: { shard?: { index?: unknown } | null; includeTaskLocation?: unknown } } | null
      )?.config;
      this.env = withNativeShard(this.env, config?.shard?.index);
    } catch {
      // Never let a surprising instance shape fail the suite.
    }
    try {
      const config = (vitest as { config?: unknown } | null)?.config;
      if (
        config !== null &&
        typeof config === "object" &&
        !(config as { includeTaskLocation?: unknown }).includeTaskLocation
      ) {
        (config as { includeTaskLocation?: unknown }).includeTaskLocation = true;
      }
    } catch {
      // A frozen/odd config (a strict-mode assignment throws): fall back to
      // the dropped-rows warning. Never fail the suite.
    }
  }

  /** Watch mode: each rerun is a run; its duration is measured from here. */
  onWatcherStart(): void {
    this.startedAtMs = Date.now();
  }

  /** Watch mode counterpart of `onWatcherStart` (fires per rerun). */
  onWatcherRerun(): void {
    this.startedAtMs = Date.now();
  }

  /**
   * Vitest 4's run-end hook. Vitest awaits the returned promise, so the
   * delivery completes before the process exits. NEVER THROWS — see the
   * class doc; the whole finish sequence is guarded, with the transport's
   * own never-throw discipline underneath.
   */
  async onTestRunEnd(
    modules: readonly unknown[],
    errors?: readonly unknown[],
    _reason?: string,
  ): Promise<void> {
    try {
      const repoRoot = this.options.repoRoot ?? process.cwd();
      const collector = new VitestCollector(repoRoot, this.startedAtMs);
      collector.onTestRunEnd(modules, errors);

      if (collector.unattributedErrors > 0) {
        process.stderr.write(
          `SpecGuard: Vitest reported ${collector.unattributedErrors} unhandled error(s) it could not attribute to a test file; they are not in the run's rows. The test run is unaffected.\n`,
        );
      }

      if (collector.dropped > 0) {
        process.stderr.write(
          `SpecGuard: dropped ${collector.dropped} test result(s) with no usable line or outcome — Vitest reports test locations only with \`includeTaskLocation: true\`, which the reporter could not enable on this Vitest config — set it in the Vitest config. The test run is unaffected.\n`,
        );
      }

      await shipRun(collector, {
        env: this.env,
        repoRoot,
        validator: this.options.validator,
        transport: this.options.transport,
      });
    } catch {
      // The never-fail guarantee: nothing here reaches the exit code.
      process.stderr.write(
        "SpecGuard: the Vitest reporter failed unexpectedly; telemetry not sent. The test run is unaffected.\n",
      );
    }
  }

  /**
   * Vitest <= 3's run-end hook. On Vitest 4 (this adapter's target) it never
   * fires; on Vitest <= 3 the `onTestRunEnd` this adapter reads does not
   * exist, so telemetry would silently never ship. One loud line converts
   * that silent no-op into a visible one and nothing more.
   */
  onFinished(): void {
    try {
      process.stderr.write(
        "SpecGuard: this Vitest version predates the reporter API this adapter reads (onTestRunEnd, Vitest >= 4.0.0); telemetry not sent. The test run is unaffected.\n",
      );
    } catch {
      // Even the warning is not allowed to throw.
    }
  }
}

export default SpecguardVitestReporter;
