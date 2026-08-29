import { spawnSync } from "node:child_process";

import { VALIDATOR_UNAVAILABLE, type ValidatorResolution } from "../core/validator.js";

/**
 * The binary-validation half of `specguard lint`: hand the in-scope SOURCE
 * FILES to the resolved `validate-intent` binary and read its findings back.
 *
 * This mirrors `specguard-rspec`'s `ValidatorBackend::Runner` (v0.2.3) so the
 * two clients share one contract on both sides of the seam:
 *
 *   * the binary is invoked as `validate-intent --source --json <patterns>` —
 *     extraction AND payload parsing happen inside the binary. This client
 *     never parses an annotation payload (see discover.ts for why: Node's
 *     `JSON.parse` accepts unpaired-surrogate escapes PROTOCOL.md §1.1(a)
 *     rejects, which is precisely why parsing belongs to the binary);
 *   * the binary's arguments are GLOB PATTERNS, so every path is escaped to
 *     match exactly itself — a path containing `[` or `*` must not silently
 *     re-expand into other files;
 *   * the argument vector is batched (byte and count budgets), findings are
 *     concatenated in argument order so the caller sees one list;
 *   * the port's own exit contract: 0 everything valid, 1 something invalid,
 *     ANYTHING ELSE means no verdict was produced;
 *   * `summary.annotations` is cross-checked against the findings — a
 *     truncated report would otherwise look like a SMALLER clean run, the
 *     exact false-green shape nobody notices.
 *
 * Every failure here is exit-2 shaped (`LintBackendError`): a broken tool
 * must never borrow the exit code that means "an annotation is malformed".
 */

/** The mode this client asks the binary for — asserted on the document. */
const SOURCE_MODE = "source";

/** Per-batch byte budget for the argv (ARG_MAX is typically ~2 MiB; stay far under). */
const MAX_ARG_BYTES = 96 * 1024;
/** Per-batch file count (some kernels cap the argument COUNT too). */
const MAX_BATCH_FILES = 1_000;

/** Renderability budget for a spawned run's output. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** A timeout, so a hung binary is a 2 and not a hung CI job. */
const RUN_TIMEOUT_MS = 60_000;

export class LintBackendError extends Error {}

/** The binary's finding, as this client carries it forward. */
export interface ValidatorFinding {
  file: string;
  /** 1-based, when the binary reported one; null otherwise. */
  line: number | null;
  kind: string;
  ok: boolean;
  errors: string[];
}

interface ValidatorDocument {
  findings: ValidatorFinding[];
  annotations: number;
}

/** `*`, `?`, `[` each wrapped in a character class so a glob matches only itself. */
export function escapeGlob(path: string): string {
  return path.replace(/([*?[])/g, "[$1]");
}

function batch(files: string[]): string[][] {
  const groups: string[][] = [[]];
  let bytes = 0;
  for (const file of files) {
    const size = Buffer.byteLength(escapeGlob(file), "utf8") + 1;
    const last = groups[groups.length - 1]!;
    if (last.length > 0 && (bytes + size > MAX_ARG_BYTES || last.length >= MAX_BATCH_FILES)) {
      groups.push([]);
      bytes = 0;
    }
    groups[groups.length - 1]!.push(file);
    bytes += size;
  }
  return groups;
}

function describe(resolution: ValidatorResolution): string {
  return resolution.state === "unavailable"
    ? "the validator backend"
    : `the validator backend at ${resolution.path}`;
}

function runBatch(
  binaryPath: string,
  patterns: string[],
): { stdout: string; stderr: string; status: number | null } {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(binaryPath, ["--source", "--json", ...patterns], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: "utf8",
    });
  } catch (error) {
    throw new LintBackendError(`the validator backend at ${binaryPath} could not be executed: ${String(error)}`);
  }
  if (result.error !== undefined) {
    throw new LintBackendError(
      `the validator backend at ${binaryPath} could not be executed: ${result.error.message}`,
    );
  }
  const status = result.status;
  if (status === null) {
    throw new LintBackendError(
      `the validator backend at ${binaryPath} did not exit normally (killed by signal ${result.signal ?? "unknown"})`,
    );
  }
  const stdout = typeof result.stdout === "string" ? result.stdout : result.stdout?.toString("utf8") ?? "";
  const stderr = typeof result.stderr === "string" ? result.stderr : result.stderr?.toString("utf8") ?? "";
  return { stdout, stderr, status };
}

/**
 * Parse ONE batch's stdout document. JSON.parse here parses the binary's
 * REPORT, not an annotation payload — the same line the Ruby client draws.
 */
function parseDocument(binaryPath: string, stdout: string, stderr: string): ValidatorDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new LintBackendError(
      `the validator backend at ${binaryPath} did not emit a JSON document: ${String(error)}` +
        (stderr.trim() !== "" ? `\n  ${stderr.trim()}` : ""),
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new LintBackendError(
      `the validator backend at ${binaryPath} emitted a non-object where a JSON document was expected`,
    );
  }
  const document = parsed as Record<string, unknown>;

  if (document["mode"] !== SOURCE_MODE) {
    throw new LintBackendError(
      `the validator backend at ${binaryPath} reported mode ${JSON.stringify(document["mode"])}, expected "${SOURCE_MODE}"`,
    );
  }

  const rawFindings = document["findings"];
  if (!Array.isArray(rawFindings)) {
    throw new LintBackendError(`the validator backend at ${binaryPath} emitted no \`findings\` array`);
  }

  const findings: ValidatorFinding[] = rawFindings.map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new LintBackendError(
        `the validator backend at ${binaryPath} emitted a findings entry (#${index}) that is not a JSON object`,
      );
    }
    const f = raw as Record<string, unknown>;
    const file = f["file"];
    if (typeof file !== "string") {
      throw new LintBackendError(
        `the validator backend at ${binaryPath} emitted a finding with no \`file\``,
      );
    }
    const kind = f["kind"];
    if (typeof kind !== "string") {
      throw new LintBackendError(
        `the validator backend at ${binaryPath} emitted a finding on ${file} with no \`kind\``,
      );
    }
    const errors = f["errors"];
    if (!Array.isArray(errors) || !errors.every((e) => typeof e === "string")) {
      throw new LintBackendError(
        `the validator backend at ${binaryPath} emitted a finding on ${file} whose \`errors\` is not a list of strings`,
      );
    }
    const line = f["line"];
    return {
      file,
      line: typeof line === "number" && Number.isInteger(line) && line > 0 ? line : null,
      kind,
      ok: f["ok"] === true,
      errors: errors as string[],
    };
  });

  const summary = document["summary"];
  const annotations =
    typeof summary === "object" && summary !== null && !Array.isArray(summary)
      ? (summary as Record<string, unknown>)["annotations"]
      : undefined;
  if (typeof annotations !== "number" || !Number.isInteger(annotations)) {
    throw new LintBackendError(
      `the validator backend at ${binaryPath} emitted no integer \`summary.annotations\``,
    );
  }

  // The count cross-check: a report truncated by a full pipe or a killed
  // batch would otherwise read as a smaller CLEAN run. `no-match`/`read`
  // kinds are statements about files, not annotation sites, exactly as in
  // the Ruby client.
  const siteKinds = findings.filter((f) => f.kind !== "read" && f.kind !== "no-match").length;
  if (siteKinds !== annotations) {
    throw new LintBackendError(
      `the validator backend at ${binaryPath} reported ${annotations} annotation(s) but emitted ${siteKinds} annotation finding(s)`,
    );
  }

  return { findings, annotations };
}

/** `no-match` carries the ESCAPED pattern in `file`; undo it via the originals map. */
function restorePath(finding: ValidatorFinding, originals: Map<string, string>): ValidatorFinding {
  if (finding.kind !== "no-match") return finding;
  const original = originals.get(finding.file) ?? finding.file;
  return { ...finding, file: original };
}

/**
 * Run the resolved binary over `files`. Throws `LintBackendError` (exit-2
 * shaped) on every way this can fail to produce verdicts; NEVER on a
 * malformed annotation — that is a finding, and findings are the product.
 */
export function checkWithBackend(resolution: ValidatorResolution, files: string[]): ValidatorFinding[] {
  if (resolution.state === "unavailable") {
    throw new LintBackendError(`${describe(resolution)} could not be resolved: ${resolution.reason}`);
  }
  const out: ValidatorFinding[] = [];
  for (const group of batch(files)) {
    const patterns = group.map(escapeGlob);
    const originals = new Map(patterns.map((pattern, i) => [pattern, group[i]!] as const));
    const { stdout, stderr, status } = runBatch(resolution.path, patterns);

    if (status !== 0 && status !== 1) {
      const tail = stderr.trim() !== "" ? `\n  ${stderr.trim()}` : "";
      throw new LintBackendError(
        `the validator backend at ${resolution.path} exited ${status} (expected 0 or 1)${tail}`,
      );
    }
    const document = parseDocument(resolution.path, stdout, stderr);
    for (const finding of document.findings) out.push(restorePath(finding, originals));
  }
  return out;
}
