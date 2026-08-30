export { buildEnvelope } from "./core/envelope.js";
export { readRunnerEnv, type RunnerEnv } from "./core/env.js";
export { deliver, GZIP_THRESHOLD_BYTES, type TransportDeps, type DeliveryResult } from "./core/transport.js";
export { exampleId } from "./core/id.js";
export type { Envelope, SpecRow } from "./core/types.js";
export {
  resolveValidator,
  VALIDATE_INTENT_ENV_VAR,
  VALIDATOR_UNAVAILABLE,
  SCHEMA_CONTRACT_DIGEST,
  type ValidatorResolution,
  type ValidatorDeps,
  type EnforcedSchema,
} from "./core/validator.js";
export { RunCollector, type TestEventData } from "./node-test/collector.js";
export { specguardReporter, type ReporterEvent, type ReporterOptions } from "./node-test/reporter.js";
export {
  SpecguardVitestReporter,
  type VitestReporterOptions,
} from "./vitest/reporter.js";
export {
  lint,
  EXIT_OK,
  EXIT_MALFORMED,
  EXIT_MISUSE,
  type LintReport,
  type LintOptions,
} from "./lint/lint.js";
export { renderHuman, renderJson } from "./lint/report.js";
