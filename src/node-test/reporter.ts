import { RunCollector } from "./collector.js";
import type { TestEventData } from "./collector.js";
import {
  readRunnerEnv,
  shardIndexFromTestShardFlag,
  withNativeShard,
  type RunnerEnv,
} from "../core/env.js";
import { resolveRunRoots, type RunRoots } from "../core/path-root.js";
import { shipRun } from "../core/ship-run.js";
import type { TransportDeps } from "../core/transport.js";

export interface ReporterEvent {
  type: string;
  data: TestEventData;
}

export interface ReporterOptions {
  /** Overrides the process environment (tests). */
  env?: RunnerEnv;
  /**
   * Root file paths are made relative to (tests). Defaults to the git
   * toplevel of the cwd (the cwd itself when git cannot say), resolved ONCE
   * at run start — the same value reaches both the collector and the
   * annotation pass, so a mid-run chdir cannot split them. An explicit value
   * also serves as the annotation walk root; by default the walk stays on
   * the cwd subtree.
   */
  repoRoot?: string;
  /** Transport injection (tests). */
  transport?: TransportDeps;
  /** Overrides `process.execArgv`, where `--test-shard=i/n` is read (tests). */
  execArgv?: readonly string[];
}

/**
 * The `node:test` custom reporter.
 *
 * Use it with Node's `--test-reporter` flag, pointing at the installed file:
 *
 *   node --test --test-reporter=spec --test-reporter=./node_modules/@yatfa/specguard/dist/node-test/reporter.js
 *
 * MUST be an async generator function, not a factory returning one — Node
 * only hands `source` to an export that is itself an async generator.
 *
 * Telemetry never fails the suite: every step here is guarded, a failed
 * delivery costs one line on stderr and a line in the local sink, and the
 * process exit code is never touched.
 */
export async function* specguardReporter(
  source: AsyncIterable<ReporterEvent>,
  options: ReporterOptions = {},
): AsyncGenerator<string> {
  const env = resolveEnv(options);
  // Bind the repo root ONCE, at run start, and thread that same value into
  // `finish` — mirroring src/jest/reporter.ts and src/vitest/reporter.ts.
  // Reading the cwd again at finish time would let a mid-run chdir
  // relativize the rows against one root and key the annotation join against
  // another, silently shipping every annotated row as `unannotated`.
  const roots = resolveRunRoots(options.repoRoot);
  const repoRoot = roots.pathRoot;
  const collector = new RunCollector(repoRoot, Date.now(), roots.walkRoot);

  for await (const ev of source) {
    try {
      switch (ev.type) {
        case "test:start":
          collector.onStart(ev.data);
          break;
        case "test:pass":
          collector.onResult(ev.data, "pass");
          break;
        case "test:fail":
          collector.onResult(ev.data, "fail");
          break;
        default:
          break;
      }
    } catch {
      // Never let a surprising event fail the suite.
    }
    yield "";
  }

  await finish(collector, env, options, roots);
}

export default specguardReporter;

/**
 * The run's env, with `--test-shard=i/n` from Node's own argv as the
 * lowest-precedence `shard_id`. The shard flag is read from `execArgv`
 * because the reporter runs in the process that was started with it.
 * Never throws.
 */
function resolveEnv(options: ReporterOptions): RunnerEnv {
  const nativeShard = shardIndexFromTestShardFlag(options.execArgv ?? process.execArgv);
  return options.env !== undefined
    ? withNativeShard(options.env, nativeShard)
    : readRunnerEnv(process, { shardIndex: nativeShard });
}

/**
 * Ship what was collected. Awaited before the reporter's stream completes so
 * Node does not exit mid-request (the test runner awaits its reporters).
 */
async function finish(
  collector: RunCollector,
  env: RunnerEnv,
  options: ReporterOptions,
  roots: RunRoots,
): Promise<void> {
  try {
    if (collector.dropped > 0) {
      process.stderr.write(
        `SpecGuard: dropped ${collector.dropped} test result(s) with no usable file/line. The test run is unaffected.\n`,
      );
    }

    // `repoRoot` is the value bound at run start, the same one the collector
    // relativized against, so discovery and the coordinate join share one
    // root. The shared pipeline does not catch; this guard's catch does.
    await shipRun(collector, {
      env,
      repoRoot: roots.pathRoot,
      walkRoot: roots.walkRoot,
      transport: options.transport,
    });
  } catch {
    // The never-fail guarantee: nothing here reaches the exit code.
  }
}
