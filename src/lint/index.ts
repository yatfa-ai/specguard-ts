export {
  lint,
  EXIT_OK,
  EXIT_MALFORMED,
  EXIT_MISUSE,
  type LintReport,
  type LintSummary,
  type LintFinding,
  type LintOptions,
} from "./lint.js";
export { renderHuman, renderJson } from "./report.js";
export {
  selectFiles,
  scanTokens,
  ANNOTATED_EXTENSIONS,
  SKIPPED_DIRECTORIES,
  INTENT_TOKEN,
  LintUsageError,
  type FileSelection,
  type FileScan,
} from "./discover.js";
export {
  checkWithBackend,
  escapeGlob,
  LintBackendError,
  type ValidatorFinding,
} from "./backend.js";
