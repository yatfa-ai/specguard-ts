import { RunCollector } from "./collector.js";
import type { TestEventData } from "./collector.js";
import { annotateRows } from "./annotate.js";
import { buildEnvelope } from "../core/envelope.js";
import { readRunnerEnv, type RunnerEnv } from "../core/env.js";
import { deliver, type TransportDeps } from "../core/transport.js";

export interface ReporterEvent {
  type: string;
  data: TestEventData;
}

export interface ReporterOptions {
  /** Overrides the process environment (tests). */
  env?: RunnerEnv;
  /** Repo root for relativizing file paths (tests). Defaults to cwd. */
  repoRoot?: string;
  /** Transport injection (tests). */
  transport?: TransportDeps;
}

/**
 * The `node:test` custom reporter.
 *
 * Use it with Node's `--test-reporter` flag, pointing at the installed file:
 *
 *   node --test --test-reporter=spec --test-reporter=./node_modules/specguard-ts/dist/node-test/reporter.js
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
  const env = options.env ?? readRunnerEnv();
  const collector = new RunCollector(options.repoRoot ?? process.cwd());

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

  await finish(collector, env, options);
}

export default specguardReporter;

/**
 * Ship what was collected. Awaited before the reporter's stream completes so
 * Node does not exit mid-request (the test runner awaits its reporters).
 */
async function finish(
  collector: RunCollector,
  env: RunnerEnv,
  options: ReporterOptions,
): Promise<void> {
  try {
    const rows = collector.getRows();

    if (collector.dropped > 0) {
      process.stderr.write(
        `SpecGuard: dropped ${collector.dropped} test result(s) with no usable file/line. The test run is unaffected.\n`,
      );
    }

    // A run that reported zero tests has nothing to say — no POST, no file.
    if (rows.length === 0) return;

    // Slice 4: attempt the annotation pass. It never throws and never
    // changes the exit code — on any failure the slice-1 rows ship as-is
    // (the pass itself emits at most one warning line).
    const annotated = annotateRows(rows, { repoRoot: options.repoRoot ?? process.cwd() });

    const envelope = buildEnvelope(annotated.rows, env, collector.durationSeconds());
    if (envelope === null) {
      process.stderr.write(
        "SpecGuard: no commit sha could be resolved (set SPECGUARD_COMMIT_SHA); telemetry not sent. The test run is unaffected.\n",
      );
      return;
    }

    await deliver(envelope, env, options.transport);
  } catch {
    // The never-fail guarantee: nothing here reaches the exit code.
  }
}
