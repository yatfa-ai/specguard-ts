import { JestCollector } from "./collector.js";
import { readRunnerEnv, withNativeShard, type RunnerEnv } from "../core/env.js";
import { resolveRunRoots } from "../core/path-root.js";
import { shipRun } from "../core/ship-run.js";
import type { TransportDeps } from "../core/transport.js";
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
  /** Root file paths are made relative to (tests). Defaults to the git toplevel of the cwd, or the cwd itself when git cannot say. */
  repoRoot?: string;
  /** Transport injection (tests). */
  transport?: TransportDeps;
  /** Validator resolution injection for the annotation pass (tests). */
  validator?: ValidatorDeps;
}

/**
 * Jest's `--shard=i/n` index: `globalConfig.shard.shardIndex`, present only
 * when the flag was passed. Never throws.
 */
function jestShardIndex(globalConfig: unknown): unknown {
  try {
    if (globalConfig === null || typeof globalConfig !== "object") return null;
    const shard = (globalConfig as { shard?: unknown }).shard;
    if (shard === null || typeof shard !== "object") return null;
    return (shard as { shardIndex?: unknown }).shardIndex ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether the Jest config sets `testLocationInResults: true`, read from the
 * (frozen — readable, never writable) `globalConfig`. `false` for anything
 * else, including an absent or malformed config. Never throws.
 */
function jestLocationInResults(globalConfig: unknown): boolean {
  try {
    if (globalConfig === null || typeof globalConfig !== "object") return false;
    return (globalConfig as { testLocationInResults?: unknown }).testLocationInResults === true;
  } catch {
    return false;
  }
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
 *     reporters: ["default", "@yatfa/specguard/jest"],
 *     testLocationInResults: true, // optional: exact lines (see below)
 *   };
 *
 * `testLocationInResults` is OPTIONAL. Without it Jest reports no test
 * locations and the reporter — which cannot switch the option on, because
 * Jest 30 hands it a frozen `globalConfig` — derives each row's line from
 * the suite's source instead (see `source-lines.ts`), says so once on
 * stderr, and ships the rows. With it the lines are Jest's own and exact.
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
  /** `globalConfig.testLocationInResults`, read up front: are Jest's lines exact? */
  private readonly locationInResults: boolean;

  constructor(
    globalConfig?: unknown,
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
      // `globalConfig.shard` exists only under `--shard=i/n`; absent or
      // malformed yields no hint. Read defensively — this constructor must
      // never throw.
      const nativeShard = jestShardIndex(globalConfig);
      env =
        this.options.env !== undefined
          ? withNativeShard(this.options.env, nativeShard)
          : readRunnerEnv(process, { shardIndex: nativeShard });
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
    this.locationInResults = jestLocationInResults(globalConfig);
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
      const { pathRoot: repoRoot, walkRoot } = resolveRunRoots(this.options.repoRoot);
      const collector = new JestCollector(repoRoot, this.startedAtMs);
      collector.onRunComplete(results);

      const derived = collector.linesDerived + collector.linesFallback;
      if (derived > 0) {
        // One notice, decided by the option read up front: with the option
        // off the lines are derived by design; with it on, Jest still left
        // some rows without a location.
        const fallback =
          collector.linesFallback > 0
            ? ` (${collector.linesFallback} could not be matched in the source and use line 1)`
            : "";
        process.stderr.write(
          this.locationInResults
            ? `SpecGuard: Jest reported no location for ${derived} test result(s) despite \`testLocationInResults\`; their line numbers were derived from the test source${fallback}. The test run is unaffected.\n`
            : `SpecGuard: \`testLocationInResults\` is off, so line numbers for ${derived} test result(s) were derived from the test source${fallback}; set \`testLocationInResults: true\` in the Jest config for exact lines. The test run is unaffected.\n`,
        );
      }

      if (collector.dropped > 0) {
        process.stderr.write(
          `SpecGuard: dropped ${collector.dropped} test result(s) with no usable line, name or outcome. The test run is unaffected.\n`,
        );
      }

      await shipRun(collector, {
        env: this.env,
        repoRoot,
        walkRoot,
        validator: this.options.validator,
        transport: this.options.transport,
      });
    } catch {
      // The never-fail guarantee: nothing here reaches the exit code.
      process.stderr.write(
        "SpecGuard: the Jest reporter failed unexpectedly; telemetry not sent. The test run is unaffected.\n",
      );
    }
  }
}

export default SpecguardJestReporter;
