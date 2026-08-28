import { execFileSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs";

/**
 * Runner-agnostic `validate-intent` binary resolution — the prerequisite for
 * every annotation-capability slice (lint, intent-on-telemetry).
 *
 * Precedence, mirroring the Ruby client (`specguard-rspec`'s
 * `ValidatorBackend.resolve`):
 *
 *   1. `SPECGUARD_VALIDATE_INTENT` names a binary. Blank counts as unset —
 *      `SPECGUARD_VALIDATE_INTENT=` in a CI env file is somebody asking for
 *      the default resolution, not for a binary named "".
 *   2. An npm-distributed prebuilt, an optional dependency resolved by
 *      `os`/`cpu`. Only the resolution SEAM exists this slice: nothing is
 *      published, no package name is decided (the bare `specguard` name is
 *      taken; owner decision pending), so the default seam resolves nothing
 *      and the answer is `unavailable`.
 *   3. `unavailable(reason)` — typed state, never a throw.
 *
 * Importing this module never throws, and every unavailable state leaves the
 * telemetry path (`./node-test`) untouched: a platform with no prebuilt
 * binary must degrade, not break.
 */

/** Names a `validate-intent` binary, overriding default resolution. */
export const VALIDATE_INTENT_ENV_VAR = "SPECGUARD_VALIDATE_INTENT";

/**
 * The schema contract this client targets: open-test-intent v1, the same
 * vendored bytes `specguard-rspec` ships (sha256 of
 * `schemas/open-test-intent.v1.json`). A binary enforcing different bytes
 * would produce verdicts under a contract this client cannot stand behind —
 * a wrong-contract binary is worse than no binary, so a mismatch is a
 * distinct refusal reason, never a silent pass.
 */
export const SCHEMA_CONTRACT_DIGEST =
  "3760d8f7c6694aa19ca53cd39c323d7c096ae1140be08c435cd433e77db618ee";

/** The flag that answers which schema a run ENFORCES (open-test-intent slice 19). */
const SCHEMA_SOURCE_FLAG = "--schema-source";

/**
 * `--schema-source` writes ONE line: `schema <origin> sha256:<64-hex>`, where
 * the origin is an absolute path or the literal `<embedded schema>`. Anchored
 * to the whole line; pinned against recorded output of the real binary (see
 * `specguard-rspec/spec/fixtures/validator/schema-source-probes.json`) so a
 * parse bug cannot silently read as "binary too old".
 */
const SCHEMA_SOURCE_PATTERN =
  /^schema (\S(?:.*\S)?) sha256:([0-9a-fA-F]{64})$/;

/** The digest token inside a `--version` line. */
const SCHEMA_DIGEST_PATTERN = /\bschema sha256:([0-9a-fA-F]{64})\b/i;

/** Renderability budget for the one-line probes (a path can be 4096 bytes). */
const PROBE_MAX_BYTES = 8 * 1024;

export interface EnforcedSchema {
  origin: string;
  digest: string;
}

export type ValidatorResolution =
  | {
      /** An env-var override named the binary and every check passed. */
      state: "overridden";
      path: string;
      /** The binary's own `--version` line, or null when it reported none. */
      identity: string | null;
      /** What `--schema-source` answered, or null when it could not. */
      enforcedSchema: EnforcedSchema | null;
    }
  | {
      /** The default (npm prebuilt) resolution produced a usable binary. */
      state: "available";
      path: string;
      identity: string | null;
      enforcedSchema: EnforcedSchema | null;
    }
  | {
      /**
       * No usable binary. `reason` is one of the `VALIDATOR_UNAVAILABLE_*`
       * constants (plus a human-readable detail) so callers can distinguish
       * "nothing here" from "something here we refuse to use".
       */
      state: "unavailable";
      reason: string;
      code: string;
    };

/** Refusal codes — distinct so slice 3+ can degrade differently per cause. */
export const VALIDATOR_UNAVAILABLE = {
  /** No env var set and no prebuilt dependency installed for this platform. */
  NO_BINARY: "no-binary",
  /** The env var named a path that does not exist. */
  OVERRIDE_MISSING: "override-missing",
  /** The env var named something that is not an executable file. */
  OVERRIDE_NOT_EXECUTABLE: "override-not-executable",
  /** The env var named a bare command name; a path is required. */
  OVERRIDE_NOT_A_PATH: "override-not-a-path",
  /** The binary could not be executed at all. */
  NOT_EXECUTABLE: "not-executable",
  /** The binary enforces a different schema contract — a refusal, not a pass. */
  SCHEMA_CONTRACT_MISMATCH: "schema-contract-mismatch",
} as const;

export interface ValidatorDeps {
  /** Environment to read (defaults to `process.env`). */
  env?: Record<string, string | undefined>;
  /**
   * The npm-prebuilt resolution seam. The default returns null: no prebuilt
   * package is published yet (name decision pending), so this slice only
   * proves the seam exists and is honored. A later slice replaces the default
   * with an optional-dependency lookup keyed on `os.platform()`/`os.arch()`.
   */
  prebuiltResolver?: () => string | null;
}

function unavailable(code: string, detail: string): ValidatorResolution {
  return { state: "unavailable", code, reason: detail };
}

function isExecutableFile(path: string): boolean {
  try {
    if (!fs.statSync(path).isFile()) return false;
    fs.accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Run the binary with args; null on any spawn failure or non-zero exit. */
function probe(
  path: string,
  args: string[],
): { stdout: string; exitCode: number } | null {
  try {
    const stdout = execFileSync(path, args, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      maxBuffer: PROBE_MAX_BYTES,
      encoding: "utf8",
    });
    return { stdout, exitCode: 0 };
  } catch (error) {
    const e = error as { status?: number; stdout?: string };
    // Non-zero exit: return the (possibly empty) stdout with its code, so the
    // caller's exit-code gates apply; spawn failures (ENOENT/EACCES) have no
    // answer at all and are null.
    if (typeof e.status === "number") {
      return { stdout: typeof e.stdout === "string" ? e.stdout : "", exitCode: e.status };
    }
    return null;
  }
}

/** One shape-checked line: trimmed, non-empty, bounded, no control chars. */
function oneLine(stdout: string): string | null {
  const text = stdout.trim();
  if (
    text.length === 0 ||
    Buffer.byteLength(text, "utf8") > PROBE_MAX_BYTES ||
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x7f]/.test(text)
  ) {
    return null;
  }
  return text;
}

/** Parse `schema <origin> sha256:<64-hex>`, or null when unreadable. */
function parseSchemaSource(stdout: string): EnforcedSchema | null {
  const line = oneLine(stdout);
  if (line === null) return null;
  const match = SCHEMA_SOURCE_PATTERN.exec(line);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  return { origin: match[1], digest: match[2].toLowerCase() };
}

/**
 * Check the identity of a resolved binary and compare its `--schema-source`
 * digest (what a run ENFORCES — a schema beside the executable beats the
 * compiled-in copy) against this client's schema contract. Returns the
 * resolution state, never throws.
 */
function checkBinary(path: string): ValidatorResolution {
  if (!isExecutableFile(path)) {
    return unavailable(
      VALIDATOR_UNAVAILABLE.NOT_EXECUTABLE,
      `the validator backend at ${path} could not be executed`,
    );
  }

  const version = probe(path, ["--version"]);
  const identity = version !== null && version.exitCode === 0
    ? oneLine(version.stdout)
    : null;

  const source = probe(path, [SCHEMA_SOURCE_FLAG]);
  const enforced = source !== null && source.exitCode === 0
    ? parseSchemaSource(source.stdout)
    : null;

  // The enforced digest wins whenever there is one — it is the only answer to
  // the question being asked. Without it (a binary predating slice 19, whose
  // failure shape on this flag is a documented edge), fall back to the
  // compiled-in digest from the identity line.
  const carriedMatch = identity !== null ? SCHEMA_DIGEST_PATTERN.exec(identity) : null;
  const carried = carriedMatch?.[1]?.toLowerCase() ?? null;
  const compared = enforced?.digest ?? carried;

  if (compared !== null && compared !== SCHEMA_CONTRACT_DIGEST) {
    const origin = enforced !== null ? `, loaded from ${enforced.origin}` : "";
    const sourceWord = enforced !== null ? "enforcing" : "carrying";
    return unavailable(
      VALIDATOR_UNAVAILABLE.SCHEMA_CONTRACT_MISMATCH,
      `the validator backend at ${path} reports ${sourceWord} schema sha256:${compared}${origin}, ` +
        `but this client targets sha256:${SCHEMA_CONTRACT_DIGEST} — the two halves would enforce ` +
        `different contracts`,
    );
  }

  return { state: "overridden", path, identity, enforcedSchema: enforced };
}

/**
 * Resolve a `validate-intent` binary. NEVER throws: every way this can fail
 * is a typed `unavailable` state, so later slices degrade per the roadmap
 * ("telemetry has to keep working when validation cannot run").
 */
export function resolveValidator(
  deps: ValidatorDeps = {},
): ValidatorResolution {
  const env = deps.env ?? process.env;

  const override = (env[VALIDATE_INTENT_ENV_VAR] ?? "").trim();
  if (override !== "") {
    // A bare command name is refused rather than resolved against PATH:
    // which binary validated a CI job should not depend on what else happens
    // to be installed. A path with a separator is required.
    if (!override.includes("/")) {
      return unavailable(
        VALIDATOR_UNAVAILABLE.OVERRIDE_NOT_A_PATH,
        `${VALIDATE_INTENT_ENV_VAR} takes a path, not a command name; try ` +
          `${VALIDATE_INTENT_ENV_VAR}="$(command -v ${override})"`,
      );
    }
    if (!fs.existsSync(override)) {
      return unavailable(
        VALIDATOR_UNAVAILABLE.OVERRIDE_MISSING,
        `the validator backend at ${override} (${VALIDATE_INTENT_ENV_VAR}) does not exist`,
      );
    }
    if (!isExecutableFile(override)) {
      return unavailable(
        VALIDATOR_UNAVAILABLE.OVERRIDE_NOT_EXECUTABLE,
        `the validator backend at ${override} (${VALIDATE_INTENT_ENV_VAR}) is not an executable file`,
      );
    }
    return checkBinary(override);
  }

  // The npm-prebuilt seam. The default resolves nothing — no package is
  // published and no name is decided — so this slice lands in the graceful
  // absence state, which is exactly what slice 3+ must learn to handle.
  const resolver = deps.prebuiltResolver ?? (() => null);
  let prebuilt: string | null = null;
  try {
    prebuilt = resolver();
  } catch {
    prebuilt = null;
  }
  if (prebuilt !== null && prebuilt !== "") {
    const checked = checkBinary(prebuilt);
    if (checked.state !== "unavailable") {
      return { ...checked, state: "available" };
    }
    return checked;
  }

  return unavailable(
    VALIDATOR_UNAVAILABLE.NO_BINARY,
    `no validate-intent binary could be resolved: ${VALIDATE_INTENT_ENV_VAR} is not set and no ` +
      `prebuilt package is installed for this platform (os=${process.platform}, arch=${process.arch})`,
  );
}
