import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveValidator,
  VALIDATE_INTENT_ENV_VAR,
  VALIDATOR_UNAVAILABLE,
  SCHEMA_CONTRACT_DIGEST,
} from "../src/core/validator.js";

const GOOD_DIGEST = SCHEMA_CONTRACT_DIGEST;
const OTHER_DIGEST = "0".repeat(64);

interface Stub {
  path: string;
}

/** A stub binary answering --version / --schema-source with fixed lines. */
function stubBinary(lines: { version?: string; schemaSource?: string; exit?: number }): Stub {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specguard-validator-"));
  const file = path.join(dir, "validate-intent");
  const versionLine = lines.version ?? `validate-intent stub (test) schema sha256:${GOOD_DIGEST}`;
  const sourceLine = lines.schemaSource ?? `schema <embedded schema> sha256:${GOOD_DIGEST}`;
  const exit = lines.exit ?? 0;
  fs.writeFileSync(
    file,
    `#!/bin/sh\ncase "$1" in\n  --version) printf '%s\\n' '${versionLine}'; exit ${exit} ;;\n  --schema-source) printf '%s\\n' '${sourceLine}'; exit ${exit} ;;\nesac\nexit 0\n`,
    { mode: 0o755 },
  );
  return { path: file };
}

/** A stub whose lines contain a single quote, written via a heredoc-safe env file. */
function stubBinaryScript(body: string): Stub {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specguard-validator-"));
  const file = path.join(dir, "validate-intent");
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { path: file };
}

function envWith(bin?: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  if (bin !== undefined) env[VALIDATE_INTENT_ENV_VAR] = bin;
  return env;
}

test("env override naming a working binary resolves overridden and echoes identity", () => {
  const stub = stubBinary({});
  const r = resolveValidator({ env: envWith(stub.path) });
  assert.equal(r.state, "overridden");
  assert.ok(r.state === "overridden");
  assert.match(r.identity!, /schema sha256:/);
  assert.equal(r.enforcedSchema!.digest, GOOD_DIGEST);
  assert.equal(r.enforcedSchema!.origin, "<embedded schema>");
});

test("env override set to a missing path is a distinct refusal, not a throw", () => {
  const r = resolveValidator({ env: envWith("/nonexistent/validate-intent") });
  assert.equal(r.state, "unavailable");
  assert.ok(r.state === "unavailable");
  assert.equal(r.code, VALIDATOR_UNAVAILABLE.OVERRIDE_MISSING);
});

test("env override set to a non-executable file is a distinct refusal", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specguard-validator-"));
  const file = path.join(dir, "plain");
  fs.writeFileSync(file, "not a program", { mode: 0o644 });
  const r = resolveValidator({ env: envWith(file) });
  assert.equal(r.state, "unavailable");
  assert.ok(r.state === "unavailable");
  assert.equal(r.code, VALIDATOR_UNAVAILABLE.OVERRIDE_NOT_EXECUTABLE);
});

test("env override naming a bare command name is refused — a path is required", () => {
  const r = resolveValidator({ env: envWith("validate-intent") });
  assert.ok(r.state === "unavailable");
  assert.equal(r.code, VALIDATOR_UNAVAILABLE.OVERRIDE_NOT_A_PATH);
});

test("blank env var counts as unset — CI env-file convention", () => {
  const r = resolveValidator({ env: envWith("   ") });
  assert.ok(r.state === "unavailable");
  assert.equal(r.code, VALIDATOR_UNAVAILABLE.NO_BINARY);
});

test("no env var and no prebuilt resolves unavailable(no-binary); importing never throws", () => {
  const r = resolveValidator({ env: {} });
  assert.ok(r.state === "unavailable");
  assert.equal(r.code, VALIDATOR_UNAVAILABLE.NO_BINARY);
});

test("a schema-source digest that differs from the contract is refused as a mismatch, distinct from missing", () => {
  const stub = stubBinary({ schemaSource: `schema <embedded schema> sha256:${OTHER_DIGEST}` });
  const r = resolveValidator({ env: envWith(stub.path) });
  assert.ok(r.state === "unavailable");
  assert.equal(r.code, VALIDATOR_UNAVAILABLE.SCHEMA_CONTRACT_MISMATCH);
  assert.match(r.reason, new RegExp(OTHER_DIGEST));
  assert.notEqual(r.code, VALIDATOR_UNAVAILABLE.OVERRIDE_MISSING);
});

test("a schema file beside the binary (on-disk origin) with our digest passes", () => {
  const stub = stubBinary({
    schemaSource: `schema /opt/schemas/open-test-intent.v1.json sha256:${GOOD_DIGEST}`,
  });
  const r = resolveValidator({ env: envWith(stub.path) });
  assert.ok(r.state === "overridden");
  assert.equal(r.enforcedSchema!.origin, "/opt/schemas/open-test-intent.v1.json");
});

test("a binary predating --schema-source falls back to the carried --version digest", () => {
  // Pre-slice-19 shape: --schema-source exits 1 with stderr noise; the
  // carried digest in --version is ours, so the check still passes.
  const stub = stubBinaryScript(
    `case "$1" in\n` +
      `  --version) printf 'validate-intent old schema sha256:${GOOD_DIGEST}\\n'; exit 0 ;;\n` +
      `  *) echo "no file(s) match" >&2; exit 1 ;;\n` +
      `esac`,
  );
  const r = resolveValidator({ env: envWith(stub.path) });
  assert.ok(r.state === "overridden");
  assert.equal(r.enforcedSchema, null);
});

test("a pre-slice-19 binary whose CARRIED digest differs is refused as a mismatch", () => {
  const stub = stubBinaryScript(
    `case "$1" in\n` +
      `  --version) printf 'validate-intent old schema sha256:${OTHER_DIGEST}\\n'; exit 0 ;;\n` +
      `  *) exit 1 ;;\n` +
      `esac`,
  );
  const r = resolveValidator({ env: envWith(stub.path) });
  assert.ok(r.state === "unavailable");
  assert.equal(r.code, VALIDATOR_UNAVAILABLE.SCHEMA_CONTRACT_MISMATCH);
});

test("the prebuilt seam is honored: a resolver naming a working binary resolves available", () => {
  const stub = stubBinary({});
  const r = resolveValidator({ env: {}, prebuiltResolver: () => stub.path });
  assert.ok(r.state === "available");
  assert.equal(r.path, stub.path);
});

test("the prebuilt seam refusing everything falls through to unavailable(no-binary)", () => {
  const r = resolveValidator({ env: {}, prebuiltResolver: () => null });
  assert.ok(r.state === "unavailable");
  assert.equal(r.code, VALIDATOR_UNAVAILABLE.NO_BINARY);
});

test("a prebuilt binary with a mismatched contract is refused, not made available", () => {
  const stub = stubBinary({ schemaSource: `schema <embedded schema> sha256:${OTHER_DIGEST}` });
  const r = resolveValidator({ env: {}, prebuiltResolver: () => stub.path });
  assert.ok(r.state === "unavailable");
  assert.equal(r.code, VALIDATOR_UNAVAILABLE.SCHEMA_CONTRACT_MISMATCH);
});

test("telemetry is unaffected by every unavailable state: the node-test reporter still constructs and runs", async () => {
  // Import the telemetry path AFTER every unavailable state has been
  // resolved in this process — proving the validator module's absence states
  // cannot break it — and run one reporter cycle end to end.
  const { specguardReporter } = await import("../src/node-test/reporter.js");
  const codes = [
    VALIDATOR_UNAVAILABLE.NO_BINARY,
    VALIDATOR_UNAVAILABLE.OVERRIDE_MISSING,
    VALIDATOR_UNAVAILABLE.OVERRIDE_NOT_EXECUTABLE,
    VALIDATOR_UNAVAILABLE.SCHEMA_CONTRACT_MISMATCH,
  ];
  for (const _code of codes) {
    const env = resolveValidator({ env: {} });
    assert.equal(env.state, "unavailable");
  }
  const lines: string[] = [];
  async function* events(): AsyncGenerator<never> {}
  for await (const line of specguardReporter(events(), {
    env: {
      commitSha: "abc", branch: "main", ciRunId: "1", shardId: "0",
      endpoint: null, apiKey: null, timeoutMs: 100, outputPath: "/dev/null",
    },
  })) {
    lines.push(line);
  }
  assert.ok(Array.isArray(lines));
});

test("a binary that cannot answer --version at all still resolves when --schema-source carries our digest", () => {
  const stub = stubBinaryScript(
    `case "$1" in\n` +
      `  --schema-source) printf 'schema <embedded schema> sha256:${GOOD_DIGEST}\\n'; exit 0 ;;\n` +
      `  *) exit 1 ;;\n` +
      `esac`,
  );
  const r = resolveValidator({ env: envWith(stub.path) });
  assert.ok(r.state === "overridden");
  assert.equal(r.identity, null);
});
