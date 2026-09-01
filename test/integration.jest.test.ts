import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Envelope, SpecRow } from "../src/core/types.js";
import { SCHEMA_CONTRACT_DIGEST } from "../src/core/validator.js";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..", "..");
const fixturesDir = join(pkgRoot, "fixtures", "jest");

/**
 * Jest is an OPTIONAL peer of this package, and this repository does not
 * depend on it — `npm install && npm test` runs green with no Jest
 * present, which is the installability guarantee this slice exists to
 * prove. These end-to-end tests therefore SELF-SKIP when no Jest is
 * resolvable (a fresh checkout, a consumer's node:test or Vitest project)
 * and run for real wherever one is installed (CI runs these self-skipped:
 * the workflow has no Jest-install step — see "Development" in the README).
 */
const jestBin = resolveJestBin();

function resolveJestBin(): string | null {
  try {
    const require = createRequire(join(pkgRoot, "package.json"));
    const pkg = require.resolve("jest/package.json") as string;
    const bin = join(dirname(pkg), "bin", "jest.js");
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

interface Captured {
  method: string;
  url: string;
  auth: string | undefined;
  contentType: string | undefined;
  userAgent: string | undefined;
  body: Envelope;
}

async function captureServer(): Promise<{
  captured: Captured[];
  url: string;
  close: () => Promise<void>;
}> {
  const captured: Captured[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      captured.push({
        method: req.method ?? "",
        url: req.url ?? "",
        auth: req.headers.authorization,
        contentType: req.headers["content-type"],
        userAgent: req.headers["user-agent"],
        body: JSON.parse(text) as Envelope,
      });
      res.statusCode = 202;
      res.end('{"test_run_id":"41f2c9b8"}');
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    captured,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve(undefined));
        server.closeAllConnections();
      }),
  };
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function childEnv(serverUrl: string, extraEnv: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SPECGUARD_ENDPOINT: serverUrl,
    SPECGUARD_API_KEY: "sgk_integration",
    SPECGUARD_COMMIT_SHA: "deadbeef",
    SPECGUARD_RUN_ID: "17442",
    SPECGUARD_SHARD_ID: "0",
    SPECGUARD_TIMEOUT: "10",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    ...extraEnv,
  };
  // Never leak the parent suite's node:test context into grandchildren.
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/**
 * One real `jest` child process over a fixture config. `extraArgs` carries
 * flags such as `--runInBand`, which the never-fail A/B test needs: Jest
 * runs suites in parallel workers whose COMPLETION ORDER is nondeterministic
 * (measured), and in-band runs are the deterministic form of the same suite.
 */
async function runJest(
  config: string,
  serverUrl: string,
  extraEnv: Record<string, string> = {},
  filter?: string,
  extraArgs: readonly string[] = [],
): Promise<RunResult> {
  if (jestBin === null) throw new Error("jest not installed");
  const configPath = config.startsWith("/") ? config : join(fixturesDir, config);
  const args = [jestBin, "--config", configPath, ...extraArgs];
  if (filter !== undefined) args.push(filter);
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: pkgRoot, // repo root for path relativization
      env: childEnv(serverUrl, extraEnv),
      timeout: 120_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    if (e.killed) throw new Error(`jest run timed out: ${config} ${filter ?? ""}`);
    return { code: e.code ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** Read a 1-based line number out of a fixture by prefix — no magic ints. */
function fixtureLineOf(fixture: string, prefix: string): number {
  const lines = readFileSync(join(fixturesDir, fixture), "utf8").split("\n");
  const i = lines.findIndex((l) => l.startsWith(prefix));
  if (i < 0) throw new Error(`fixture lost: ${fixture}: ${prefix}`);
  return i + 1;
}

test("end to end: a real Jest run with zero annotations POSTs and is accepted (202)", async (t) => {
  if (jestBin === null) return t.skip("jest not installed — adapter e2e skipped (optional peer)");
  const srv = await captureServer();
  try {
    const result = await runJest("jest.config.mjs", srv.url, {}, "fixtures/jest/mixed.test.js");
    assert.equal(result.code, 1, "mixed fixture fails one test — the suite's own exit code");
    assert.equal(srv.captured.length, 1, `captured: ${result.stderr}`);
    const req = srv.captured[0]!;
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/api/v1/ingest");
    assert.equal(req.auth, "Bearer sgk_integration");
    assert.equal(req.contentType, "application/json");
    assert.match(req.userAgent ?? "", /^specguard-ts\//);
    assert.equal(req.body.commit_sha, "deadbeef");
  } finally {
    await srv.close();
  }
});

test("end to end: 6 tests (nested + one top level) produce exactly 6 rows, the failure reported once", async (t) => {
  if (jestBin === null) return t.skip("jest not installed — adapter e2e skipped (optional peer)");
  const srv = await captureServer();
  try {
    await runJest("jest.config.mjs", srv.url, {}, "fixtures/jest/mixed.test.js");
    const specs = srv.captured[0]!.body.specs;
    assert.equal(specs.length, 6, JSON.stringify(specs.map((s) => s.name)));
    const failed = specs.filter((s) => s.outcome === "failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.name, "passing suite > child failing");
  } finally {
    await srv.close();
  }
});

test("end to end: lines, relative paths, composed names, seconds durations, pending outcomes", async (t) => {
  if (jestBin === null) return t.skip("jest not installed — adapter e2e skipped (optional peer)");
  const srv = await captureServer();
  try {
    await runJest("jest.config.mjs", srv.url, {}, "fixtures/jest/mixed.test.js");
    const specs = srv.captured[0]!.body.specs;
    const byName = new Map<string, SpecRow>(specs.map((s) => [s.name, s]));

    // line_number — the `it(` call line in fixtures/jest/mixed.test.ts,
    // read from the fixture itself (the anchor `location.line` reports)
    assert.equal(byName.get("passing suite > child ok")?.line_number, fixtureLineOf("mixed.test.js", '  it("child ok"'));
    assert.equal(byName.get("passing suite > inner suite > grandchild ok")?.line_number, fixtureLineOf("mixed.test.js", '    it("grandchild ok"'));
    assert.equal(byName.get("passing suite > child failing")?.line_number, fixtureLineOf("mixed.test.js", '  it("child failing"'));

    // file_path — repo-relative
    assert.equal(byName.get("passing suite > child ok")?.file_path, "fixtures/jest/mixed.test.js");

    // composed ancestry — two levels, three segments, the " > " join the
    // other two adapters produce, RECOMPOSED because Jest's own fullName
    // joins with a single space (measured)
    assert.ok(byName.has("passing suite > inner suite > grandchild ok"));
    assert.ok(!byName.has("passing suite inner suite grandchild ok"), "Jest's space-joined fullName must not reach the wire");
    assert.ok(!byName.has("fixtures/jest/mixed.test.js > passing suite > child ok"));
    // a top-level test composes to its bare name
    assert.ok(byName.has("top level ok"));

    // duration — seconds: the 80ms sleep lands in [0.05, 2.0], not near 80
    const slept = byName.get("passing suite > child ok")?.duration;
    assert.ok(
      slept !== null && slept !== undefined && slept >= 0.05 && slept <= 2.0,
      `duration ${String(slept)} not in seconds`,
    );

    // skip and todo both ship as pending, never silently a pass
    assert.equal(byName.get("passing suite > child skipped")?.outcome, "pending");
    assert.equal(byName.get("passing suite > child todo")?.outcome, "pending");
    assert.equal(byName.get("passing suite > child todo")?.duration, null);

    // ci_run_id / shard_id strings on the wire — assert on the raw JSON
    const raw = JSON.stringify(srv.captured[0]!.body);
    assert.ok(raw.includes('"ci_run_id":"17442"'));
    assert.ok(raw.includes('"shard_id":"0"'));
    assert.ok(!raw.includes('"shard_id":0'));

    // cold-start rows: unannotated, unique ids
    for (const spec of specs) {
      assert.equal(spec.status, "unannotated");
      assert.equal(spec.intent, null);
      assert.ok(spec.id.length > 0);
    }
    const ids = specs.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
  } finally {
    await srv.close();
  }
});

test("the same suite run twice produces identical ids", async (t) => {
  if (jestBin === null) return t.skip("jest not installed — adapter e2e skipped (optional peer)");
  const srv = await captureServer();
  try {
    await runJest("jest.config.mjs", srv.url, {}, "fixtures/jest/mixed.test.js");
    await runJest("jest.config.mjs", srv.url, {}, "fixtures/jest/mixed.test.js");
    const a = srv.captured[0]!.body.specs.map((s) => s.id).sort();
    const b = srv.captured[1]!.body.specs.map((s) => s.id).sort();
    assert.deepEqual(a, b);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// Slice 7, requirement: coordinate discipline is MEASURED, not inherited.
// These tests pin, against a real Jest run, (a) which line `location.line`
// points at and (b) the offset from the annotation comment to it — the
// facts the shared annotate path's 1-line lookback rests on. They also pin
// the flag that gates coordinates existing at all.

test("MEASURED: Jest's location.line points at the 1-based `it(` call line (with testLocationInResults)", async (t) => {
  if (jestBin === null) return t.skip("jest not installed — adapter e2e skipped (optional peer)");
  const srv = await captureServer();
  try {
    await runJest("jest.config.mjs", srv.url, {}, "fixtures/jest/mixed.test.js");
    const byName = new Map(srv.captured[0]!.body.specs.map((s) => [s.name, s]));
    for (const [name, prefix] of [
      ["passing suite > child ok", '  it("child ok"'],
      ["passing suite > inner suite > grandchild ok", '    it("grandchild ok"'],
      ["passing suite > child failing", '  it("child failing"'],
      ["passing suite > child skipped", '  it.skip("child skipped"'],
    ] as const) {
      assert.equal(
        byName.get(name)?.line_number,
        fixtureLineOf("mixed.test.js", prefix),
        `${name}: location.line must be the it( call line`,
      );
    }
  } finally {
    await srv.close();
  }
});

test("MEASURED: the @intent comment sits exactly one line above location.line — the shared lookback", async (t) => {
  if (jestBin === null) return t.skip("jest not installed — adapter e2e skipped (optional peer)");
  const srv = await captureServer();
  try {
    await runJest("jest.config.mjs", srv.url, {}, "fixtures/jest/annotated.test.js");
    const byName = new Map(srv.captured[0]!.body.specs.map((s) => [s.name, s]));
    // The offset annotate.ts assumes (ANNOTATION_LOOKBACK_LINES === 1),
    // measured on Jest's coordinates rather than inherited from node:test.
    assert.equal(
      byName.get("applies a valid promo code")!.line_number -
        fixtureLineOf("annotated.test.js", '// @intent: {"entity":"Cart","action":"apply promo code","behavior":"applies the discount'),
      1,
    );
    assert.equal(
      byName.get("rejects an expired promo code")!.line_number -
        fixtureLineOf("annotated.test.js", '// @intent: {"entity":"Cart","action":"apply promo code","behavior":"rejects an expired code'),
      1,
    );
  } finally {
    await srv.close();
  }
});

test("MEASURED: without testLocationInResults every row is dropped with a warning and nothing POSTs", async (t) => {
  if (jestBin === null) return t.skip("jest not installed — adapter e2e skipped (optional peer)");
  const srv = await captureServer();
  try {
    const result = await runJest("no-location.config.mjs", srv.url);
    assert.equal(srv.captured.length, 0, "no line numbers -> no rows -> no POST");
    assert.match(result.stderr, /dropped \d+ test result/);
    assert.match(result.stderr, /testLocationInResults/);
    assert.ok(!/unhandled rejection/i.test(result.stderr), result.stderr);
  } finally {
    await srv.close();
  }
});

test("MEASURED: the bare specifier through the exports map loads the ESM default export", async (t) => {
  if (jestBin === null) return t.skip("jest not installed — adapter e2e skipped (optional peer)");
  // The consumer-facing form `reporters: ["default", "specguard-ts/jest"]`
  // resolves through package.json's exports map. Pin it by making this
  // repository resolvable under its own name (a symlink in node_modules),
  // exactly how the fact was first measured — never touching a real
  // install if one exists.
  const linkPath = join(pkgRoot, "node_modules", "specguard-ts");
  if (existsSync(linkPath)) return t.skip("node_modules/specguard-ts already exists — not shadowing it");
  const configDir = mkdtempSync(join(tmpdir(), "specguard-jest-bare-"));
  const srv = await captureServer();
  let linked = false;
  try {
    symlinkSync(pkgRoot, linkPath);
    linked = true;
    const config = join(configDir, "jest.config.mjs");
    writeFileSync(config, [
      "export default {",
      `  rootDir: ${JSON.stringify(pkgRoot)},`,
      '  testMatch: ["<rootDir>/fixtures/jest/annotated.test.js"],',
      '  reporters: ["default", "specguard-ts/jest"],',
      "  testLocationInResults: true,",
      "};",
      "",
    ].join("\n"));
    const result = await runJest(config, srv.url, {});
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.equal(srv.captured.length, 1, `the exports-map entry must load and deliver: ${result.stderr}`);
    assert.equal(srv.captured[0]!.body.specs.length, 3);
  } finally {
    await srv.close();
    rmSync(configDir, { recursive: true, force: true });
    if (linked) unlinkSync(linkPath);
  }
});

// ---------------------------------------------------------------------------
// Slice 7: validator-ratified intent on telemetry, end to end through the
// unchanged shared annotate path.

/** A stub `validate-intent` binary keyed at the annotation COMMENT lines. */
async function intentStubBackend(): Promise<string> {
  const doc = JSON.stringify({
    mode: "source",
    findings: [
      {
        file: "fixtures/jest/annotated.test.js",
        line: fixtureLineOf("annotated.test.js", '// @intent: {"entity":"Cart","action":"apply promo code","behavior":"applies the discount'),
        kind: null,
        ok: true,
        errors: [],
        intent: {
          entity: "Cart",
          action: "apply promo code",
          behavior: "applies the discount when the code is valid",
          layer: "unit",
        },
      },
      {
        file: "fixtures/jest/annotated.test.js",
        line: fixtureLineOf("annotated.test.js", '// @intent: {"entity":"Cart","action":"apply promo code","behavior":"rejects an expired code'),
        kind: null,
        ok: true,
        errors: [],
        intent: {
          entity: "Cart",
          action: "apply promo code",
          behavior: "rejects an expired code with a user-facing error",
          layer: "unit",
        },
      },
    ],
    summary: { annotations: 2 },
  });
  const dir = mkdtempSync(join(tmpdir(), "specguard-validator-"));
  const file = join(dir, "validate-intent");
  writeFileSync(
    file,
    [
      "#!/bin/sh",
      "case \"$1\" in",
      `  --version) printf '%s\\n' 'validate-intent stub (jest) schema sha256:${SCHEMA_CONTRACT_DIGEST}'; exit 0 ;;`,
      `  --schema-source) printf '%s\\n' 'schema <embedded schema> sha256:${SCHEMA_CONTRACT_DIGEST}'; exit 0 ;;`,
      "esac",
      "if [ \"$1\" = \"--source\" ]; then",
      `  printf '%s\\n' '${doc.replace(/'/g, `'\\''`)}'`,
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
  return file;
}

test("end to end: annotated Jest sources POST rows with status annotated and the intent verbatim", async (t) => {
  if (jestBin === null) return t.skip("jest not installed — adapter e2e skipped (optional peer)");
  const stub = await intentStubBackend();
  const srv = await captureServer();
  try {
    const result = await runJest("jest.config.mjs", srv.url, {
      SPECGUARD_VALIDATE_INTENT: stub,
    }, "fixtures/jest/annotated.test.js");
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.equal(srv.captured.length, 1);
    const specs = srv.captured[0]!.body.specs;
    assert.equal(specs.length, 3);
    const byName = new Map(specs.map((s) => [s.name, s]));
    const applied = byName.get("applies a valid promo code")!;
    assert.equal(applied.status, "annotated");
    assert.deepEqual(applied.intent, {
      entity: "Cart",
      action: "apply promo code",
      behavior: "applies the discount when the code is valid",
      layer: "unit",
    });
    const rejected = byName.get("rejects an expired promo code")!;
    assert.equal(rejected.status, "annotated");
    assert.deepEqual(rejected.intent, {
      entity: "Cart",
      action: "apply promo code",
      behavior: "rejects an expired code with a user-facing error",
      layer: "unit",
    });
    const bare = byName.get("has no annotation above it")!;
    assert.equal(bare.status, "unannotated");
    assert.equal(bare.intent, null);
  } finally {
    await srv.close();
  }
});

test("never-fail end to end: annotations present but NO binary ⇒ unannotated rows, exit code untouched", async (t) => {
  if (jestBin === null) return t.skip("jest not installed — adapter e2e skipped (optional peer)");
  const srv = await captureServer();
  try {
    const result = await runJest("jest.config.mjs", srv.url, {
      SPECGUARD_VALIDATE_INTENT: "/nonexistent/validate-intent",
    }, "fixtures/jest/annotated.test.js");
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.equal(srv.captured.length, 1);
    const specs = srv.captured[0]!.body.specs;
    assert.equal(specs.length, 3);
    for (const spec of specs) {
      assert.equal(spec.status, "unannotated");
      assert.equal(spec.intent, null);
    }
    assert.match(result.stderr, /validator backend could not be resolved/);
    assert.match(result.stderr, /test run is unaffected/);
  } finally {
    await srv.close();
  }
});

/**
 * Strip the default reporter's run-varying numbers (durations, timestamps,
 * memory) so two runs of the SAME suite can be compared for content.
 * Everything left — test names, verdicts, failure blocks, summaries — is
 * deterministic output of the suite itself. (Jest's default reporter writes
 * to STDERR, measured: stdout is empty — so stderr is the compared stream.)
 */
function normalizeJestOutput(out: string): string {
  return out
    .replace(/^\s*Time:.*$\n?/gm, "")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|GB|MB|KiB)\b/g, "<time>")
    .replace(/\(\s*[^)\n]*<time>(?:[^)\n]*<time>)*\s*\)/g, "(<timings>)")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function specGuardLines(stderr: string): string {
  return stderr
    .split("\n")
    .filter((l) => l.startsWith("SpecGuard:"))
    .join("\n");
}

test("never-fail end to end: a 401 endpoint leaves exit code and test results identical to no reporter", async (t) => {
  if (jestBin === null) return t.skip("jest not installed — adapter e2e skipped (optional peer)");
  const refused = http.createServer((req, res) => {
    res.statusCode = 401;
    res.end("unauthorized");
  });
  refused.listen(0, "127.0.0.1");
  await once(refused, "listening");
  const port = (refused.address() as AddressInfo).port;
  try {
    // A/B: the same failing suite (exit 1) without and with the reporter
    // pointed at a 401 endpoint, in-band — Jest's parallel workers complete
    // suites in nondeterministic order (measured), and the in-band run is
    // the deterministic form of the same suite. Exit code and test results
    // must be identical; the reporter's whole footprint is stderr lines.
    const baseline = await runJest("baseline.config.mjs", `http://127.0.0.1:${port}`, undefined, undefined, ["--runInBand"]);
    const reported = await runJest("jest.config.mjs", `http://127.0.0.1:${port}`, undefined, undefined, ["--runInBand"]);
    assert.equal(baseline.code, 1);
    assert.equal(reported.code, baseline.code, "the reporter must not touch the exit code");
    assert.ok(!/unhandled rejection/i.test(reported.stderr), reported.stderr);
    assert.match(reported.stderr, /HTTP 401/);

    // Test results byte-identical modulo timings: the default reporter's
    // STDERR after normalization (Jest writes all reporter output there —
    // measured), plus stdout, which is byte-identical because both runs
    // print nothing to it.
    assert.equal(reported.stdout, baseline.stdout,
      "stdout must be byte-identical without/with the reporter");
    assert.equal(
      normalizeJestOutput(reported.stderr.replace(/^SpecGuard:.*$\n?/gm, "")),
      normalizeJestOutput(baseline.stderr),
      "stderr minus the SpecGuard lines must match the baseline",
    );
    assert.ok(specGuardLines(reported.stderr).length > 0);
    assert.equal(specGuardLines(baseline.stderr), "");
  } finally {
    refused.close();
    refused.closeAllConnections();
  }
});

test("never-fail end to end: a passing suite stays exit 0 with a failing endpoint", async (t) => {
  if (jestBin === null) return t.skip("jest not installed — adapter e2e skipped (optional peer)");
  const result = await runJest("jest.config.mjs", "http://127.0.0.1:1", {}, "fixtures/jest/annotated.test.js");
  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  assert.ok(!/unhandled rejection/i.test(result.stderr), result.stderr);
});

test("no API key: the run is written to the LOCAL sink, the replay queue is not touched, and nothing is sent", async (t) => {
  if (jestBin === null) return t.skip("jest not installed — adapter e2e skipped (optional peer)");
  const srv = await captureServer();
  const tmp = mkdtempSync(join(tmpdir(), "specguard-ts-"));
  try {
    const result = await runJest("jest.config.mjs", srv.url, {
      SPECGUARD_API_KEY: "",
      SPECGUARD_LOCAL_OUTPUT_PATH: join(tmp, "local.jsonl"),
      SPECGUARD_OUTPUT_PATH: join(tmp, "queue.jsonl"),
    }, "fixtures/jest/mixed.test.js");
    assert.equal(result.code, 1, "the suite's own failure, untouched");
    assert.equal(srv.captured.length, 0);
    const local = readFileSync(join(tmp, "local.jsonl"), "utf8").trim().split("\n");
    assert.equal(local.length, 1);
    const parsed = JSON.parse(local[0]!) as Envelope;
    assert.equal(parsed.specs.length, 6);
    assert.equal(parsed.commit_sha, "deadbeef");
    assert.equal(existsSync(join(tmp, "queue.jsonl")), false,
      "a keyless run must not land in the replay queue");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    await srv.close();
  }
});
