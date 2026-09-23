import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import type { Envelope } from "../src/core/types.js";
import { version } from "../src/core/transport.js";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..", "..");
const reporterPath = join(pkgRoot, "dist", "node-test", "reporter.js");
const fixturesDir = join(pkgRoot, "fixtures");

interface Captured {
  method: string;
  url: string;
  auth: string | undefined;
  contentType: string | undefined;
  encoding: string | undefined;
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
      const raw = Buffer.concat(chunks);
      const text =
        req.headers["content-encoding"] === "gzip"
          ? gunzipSync(raw).toString("utf8")
          : raw.toString("utf8");
      captured.push({
        method: req.method ?? "",
        url: req.url ?? "",
        auth: req.headers.authorization,
        contentType: req.headers["content-type"],
        encoding: req.headers["content-encoding"],
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
    ...extraEnv,
  };
  // The parent test runner exports NODE_TEST_CONTEXT to ITS children; leaking
  // it into the grandchild `node --test` makes the grandchild run in
  // child-report mode (exit 0, no reporter events). Delete, don't null it —
  // an explicit undefined is stringified, not removed.
  delete env.NODE_TEST_CONTEXT;
  return env;
}

async function runNodeTest(
  fixture: string,
  serverUrl: string,
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        "--test",
        `--test-reporter=${reporterPath}`,
        join(fixturesDir, fixture),
      ],
      {
        cwd: pkgRoot, // repo root for path relativization
        env: childEnv(serverUrl, extraEnv),
      },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("end to end: a real node:test run with zero annotations POSTs and is accepted (202)", async () => {
  const srv = await captureServer();
  try {
    const result = await runNodeTest("mixed.test.js", srv.url);
    assert.equal(srv.captured.length, 1, `captured: ${JSON.stringify(srv.captured.map((c) => c.body.specs.length))}`);
    const req = srv.captured[0]!;
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/api/v1/ingest");
    assert.equal(req.auth, "Bearer sgk_integration");
    assert.equal(req.contentType, "application/json");
    assert.equal(req.userAgent, `specguard-ts/${version()}`);
    assert.equal(req.body.commit_sha, "deadbeef");
  } finally {
    await srv.close();
  }
});

test("end to end: 4 tests in 2 describes produce exactly 4 rows, the failure reported once", async () => {
  const srv = await captureServer();
  try {
    await runNodeTest("mixed.test.js", srv.url);
    const specs = srv.captured[0]!.body.specs;
    assert.equal(specs.length, 4, JSON.stringify(specs.map((s) => s.name)));
    const failed = specs.filter((s) => s.outcome === "failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.name, "passing suite > child failing");
  } finally {
    await srv.close();
  }
});

test("end to end: line numbers, relative paths, composed names, seconds durations, string shard ids", async () => {
  const srv = await captureServer();
  try {
    await runNodeTest("mixed.test.js", srv.url);
    const specs = srv.captured[0]!.body.specs;

    const byName = new Map(specs.map((s) => [s.name, s]));

    // line_number — known lines in fixtures/mixed.test.js, including nested
    assert.equal(byName.get("passing suite > child ok")?.line_number, 9);
    assert.equal(byName.get("passing suite > inner suite > grandchild ok")?.line_number, 15);
    assert.equal(byName.get("passing suite > child failing")?.line_number, 18);
    assert.equal(byName.get("passing suite > child skipped")?.line_number, 22);

    // file_path — repo-relative
    assert.equal(byName.get("passing suite > child ok")?.file_path, "fixtures/mixed.test.js");

    // composed ancestry — two levels, three segments
    assert.ok(byName.has("passing suite > inner suite > grandchild ok"));

    // duration — seconds: the 80ms sleep lands in [0.05, 2.0], not near 80
    const slept = byName.get("passing suite > child ok")?.duration;
    assert.ok(
      slept !== null && slept !== undefined && slept >= 0.05 && slept <= 2.0,
      `duration ${String(slept)} not in seconds`,
    );

    // skipped ships as pending, not passed
    assert.equal(byName.get("passing suite > child skipped")?.outcome, "pending");

    // ci_run_id / shard_id strings on the wire — assert on the raw JSON
    const raw = JSON.stringify(srv.captured[0]!.body);
    assert.ok(raw.includes('"ci_run_id":"17442"'));
    assert.ok(raw.includes('"shard_id":"0"'));
    assert.ok(!raw.includes('"shard_id":0'));

    // status/intent: cold-start rows
    for (const spec of specs) {
      assert.equal(spec.status, "unannotated");
      assert.equal(spec.intent, null);
      assert.ok(spec.id.length > 0);
    }

    // stable unique ids
    const ids = specs.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
  } finally {
    await srv.close();
  }
});

test("end to end: the same suite run twice produces identical ids", async () => {
  const srv = await captureServer();
  try {
    await runNodeTest("mixed.test.js", srv.url);
    await runNodeTest("mixed.test.js", srv.url);
    const a = srv.captured[0]!.body.specs.map((s) => s.id).sort();
    const b = srv.captured[1]!.body.specs.map((s) => s.id).sort();
    assert.deepEqual(a, b);
  } finally {
    await srv.close();
  }
});

test("end to end: a zero-test file does not crash and does not POST", async () => {
  const srv = await captureServer();
  try {
    const result = await runNodeTest("empty.test.js", srv.url);
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.equal(srv.captured.length, 0);
  } finally {
    await srv.close();
  }
});

test("never-fail end to end: a 401 endpoint leaves the child runner's exit code alone", async () => {
  // A failing fixture suite: node --test exits 1. The reporter talking to a
  // 401 endpoint must not change that, and must not emit an unhandled rejection.
  const refused = http.createServer((req, res) => {
    res.statusCode = 401;
    res.end("unauthorized");
  });
  refused.listen(0, "127.0.0.1");
  await once(refused, "listening");
  const port = (refused.address() as AddressInfo).port;
  try {
    const result = await runNodeTest("mixed.test.js", `http://127.0.0.1:${port}`);
    assert.equal(result.code, 1, "exit code must be the suite's own failure, untouched");
    assert.ok(!/unhandled rejection/i.test(result.stderr), result.stderr);
    assert.match(result.stderr, /HTTP 401/);
  } finally {
    refused.close();
    refused.closeAllConnections();
  }
});

test("never-fail end to end: an unreachable endpoint leaves a passing suite's exit code at 0", async () => {
  const result = await runNodeTest("mixed.test.js", "http://127.0.0.1:1");
  // mixed.test.js fails one test, so the suite's own code is 1 — the reporter
  // must not add to it and not crash. Use the empty fixture for a clean 0.
  const passing = await runNodeTest("empty.test.js", "http://127.0.0.1:1");
  assert.equal(passing.code, 0, `stderr: ${passing.stderr}`);
  assert.ok(!/unhandled rejection/i.test(passing.stderr), passing.stderr);
  assert.ok(!/unhandled rejection/i.test(result.stderr));
});

test("no API key: the run is written to the LOCAL sink, the replay queue is not touched, and nothing is sent", async () => {
  const srv = await captureServer();
  const tmp = mkdtempSync(join(tmpdir(), "specguard-ts-"));
  try {
    const result = await runNodeTest("mixed.test.js", srv.url, {
      SPECGUARD_API_KEY: "",
      SPECGUARD_LOCAL_OUTPUT_PATH: join(tmp, "local.jsonl"),
      SPECGUARD_OUTPUT_PATH: join(tmp, "queue.jsonl"),
    });
    assert.equal(srv.captured.length, 0);
    // The local development record holds the run...
    const local = readFileSync(join(tmp, "local.jsonl"), "utf8").trim().split("\n");
    assert.equal(local.length, 1);
    const parsed = JSON.parse(local[0]!) as Envelope;
    assert.equal(parsed.specs.length, 4);
    assert.equal(parsed.commit_sha, "deadbeef");
    // ...and the replay queue is NOT touched — the two sinks are asserted
    // separately because a single shared file is exactly the defect this
    // split exists to prevent.
    assert.equal(existsSync(join(tmp, "queue.jsonl")), false,
      "a keyless run must not land in the replay queue");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// Slice 4: validator-ratified intent on telemetry, end to end.

/** Annotate the real fixture by READING its lines — no restated magic numbers. */
import { SCHEMA_CONTRACT_DIGEST } from "../src/core/validator.js";

const fixtureLines = readFileSync(join(fixturesDir, "annotated.test.js"), "utf8").split("\n");
function fixtureLineOf(prefix: string): number {
  const i = fixtureLines.findIndex((l) => l.startsWith(prefix));
  if (i < 0) throw new Error(`fixture lost: ${prefix}`);
  return i + 1;
}

/**
 * A stub `validate-intent` v0.1.4-shaped binary: answers the probe flags
 * with the contract digest, and answers `--source --json` with passing
 * findings carrying `intent`, keyed at each annotation COMMENT's line.
 */
async function intentStubBackend(): Promise<string> {
  const doc = JSON.stringify({
    mode: "source",
    findings: [
      {
        file: "fixtures/annotated.test.js",
        line: fixtureLineOf('// @intent: {"entity":"Cart","action":"apply promo code","behavior":"applies the discount'),
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
        file: "fixtures/annotated.test.js",
        line: fixtureLineOf('// @intent: {"entity":"Cart","action":"apply promo code","behavior":"rejects an expired code'),
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
      `  --version) printf '%s\\n' 'validate-intent stub (intent) schema sha256:${SCHEMA_CONTRACT_DIGEST}'; exit 0 ;;`,
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

test("end to end: annotated suite POSTs rows with status annotated and the intent verbatim", async () => {
  const stub = await intentStubBackend();
  const srv = await captureServer();
  try {
    const result = await runNodeTest("annotated.test.js", srv.url, {
      SPECGUARD_VALIDATE_INTENT: stub,
    });
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

test("never-fail end to end: annotations present but NO binary ⇒ slice-1 rows, exit code untouched", async () => {
  const srv = await captureServer();
  try {
    const result = await runNodeTest("annotated.test.js", srv.url, {
      SPECGUARD_VALIDATE_INTENT: "/nonexistent/validate-intent",
    });
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

// ---------------------------------------------------------------------------
// SPGD-1411: the reporter binds its repo root ONCE, at run start.
//
// Every test above runs the README's documented `node --test` form, where the
// tests execute in CHILD processes and the reporter runs in the parent — so a
// test's `process.chdir` can never reach the reporter. This pair drives the
// IN-PROCESS form (`node --test-reporter=… file.js`), which is the only
// invocation whose cwd the reporter shares, and is therefore the only one
// that can observe a mid-run move.
//
// The pair is an ARM PAIR and both arms are load-bearing: the no-chdir arm is
// the POSITIVE CONTROL and must annotate. A pair where NEITHER arm annotates
// measures nothing — it is satisfied by a rig that simply never annotates.
//
// Reproduced against pre-fix `dist/`: control annotated, chdir arm shipped
// `status=unannotated intent=null` for the same row.

/**
 * A scratch repo root holding a two-file tree, so discovery's scope is
 * genuinely root-dependent (root → 2 files; root/sub → 1), plus a stub
 * validator answering for both fixtures.
 *
 * The annotated fixture is COPIED from the repo's own `fixtures/annotated.
 * test.js` header shape (an `// @intent:` comment on the line directly above
 * the `test(` call) rather than hand-written, and its annotation line is READ
 * back from the file it writes — no restated magic numbers.
 */
function scratchRepo(): {
  root: string;
  validator: string;
  plainFixture: string;
  chdirFixture: string;
  annotationLineOf: (fixture: string) => number;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "specguard-chdir-"));
  mkdirSync(join(root, "sub"), { recursive: true });
  // A second file below `sub/`, so the two candidate roots select different
  // file sets and a wrong root is a genuinely wrong discovery scope.
  writeFileSync(join(root, "sub", "other.test.js"), 'import { test } from "node:test";\ntest("elsewhere", () => {});\n');

  const intentComment =
    '// @intent: {"entity":"Cart","action":"apply promo code","behavior":"applies the discount when the code is valid","layer":"unit"}';

  // Two fixtures differing ONLY in whether the second test moves the cwd.
  const body = (moves: boolean): string =>
    [
      'import { test } from "node:test";',
      "",
      intentComment,
      'test("applies a valid promo code", async () => { await new Promise((r) => setTimeout(r, 20)); });',
      "",
      moves
        ? 'test("second", async () => { await new Promise((r) => setTimeout(r, 20)); process.chdir("sub"); });'
        : 'test("second", async () => { await new Promise((r) => setTimeout(r, 20)); });',
      "",
    ].join("\n");

  writeFileSync(join(root, "plain.test.js"), body(false));
  writeFileSync(join(root, "moves.test.js"), body(true));

  const annotationLineOf = (fixture: string): number => {
    const lines = readFileSync(join(root, fixture), "utf8").split("\n");
    const i = lines.findIndex((l) => l.startsWith("// @intent:"));
    if (i < 0) throw new Error(`fixture lost its annotation: ${fixture}`);
    return i + 1;
  };

  // The REAL validator seam: a v0.1.4-shaped stub answering the probe flags
  // with the contract digest and `--source --json` with passing findings for
  // both fixtures, keyed at each annotation COMMENT's line.
  const findings = ["plain.test.js", "moves.test.js"].map((file) => ({
    file,
    line: annotationLineOf(file),
    kind: null,
    ok: true,
    errors: [],
    intent: {
      entity: "Cart",
      action: "apply promo code",
      behavior: "applies the discount when the code is valid",
      layer: "unit",
    },
  }));
  const doc = JSON.stringify({ mode: "source", findings, summary: { annotations: findings.length } });
  const validator = join(root, "validate-intent");
  writeFileSync(
    validator,
    [
      "#!/bin/sh",
      'case "$1" in',
      `  --version) printf '%s\\n' 'validate-intent stub (intent) schema sha256:${SCHEMA_CONTRACT_DIGEST}'; exit 0 ;;`,
      `  --schema-source) printf '%s\\n' 'schema <embedded schema> sha256:${SCHEMA_CONTRACT_DIGEST}'; exit 0 ;;`,
      "esac",
      'if [ "$1" = "--source" ]; then',
      `  printf '%s\\n' '${doc.replace(/'/g, `'\\''`)}'`,
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n") + "\n",
    { mode: 0o755 },
  );

  return {
    root,
    validator,
    plainFixture: "plain.test.js",
    chdirFixture: "moves.test.js",
    annotationLineOf,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Run one fixture through the REAL built reporter under the IN-PROCESS form,
 * with `root` as cwd, and return the shipped envelope read back from the
 * local sink (no API key ⇒ local sink, no network).
 */
async function runInProcess(
  repo: ReturnType<typeof scratchRepo>,
  fixture: string,
): Promise<{ envelope: Envelope; result: RunResult }> {
  const sink = join(repo.root, `${fixture}.sink.jsonl`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SPECGUARD_API_KEY: "",
    SPECGUARD_COMMIT_SHA: "deadbeef",
    SPECGUARD_LOCAL_OUTPUT_PATH: sink,
    SPECGUARD_OUTPUT_PATH: join(repo.root, "queue.jsonl"),
    SPECGUARD_VALIDATE_INTENT: repo.validator,
  };
  delete env.NODE_TEST_CONTEXT;

  let result: RunResult;
  try {
    // NOTE: no `--test` flag — that is what keeps the fixture IN THIS
    // process, where its chdir is observable by the reporter.
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [`--test-reporter=${reporterPath}`, join(repo.root, fixture)],
      { cwd: repo.root, env },
    );
    result = { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    result = { code: e.code ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }

  const lines = readFileSync(sink, "utf8").trim().split("\n");
  return { envelope: JSON.parse(lines[lines.length - 1]!) as Envelope, result };
}

test("in-process control: a run whose cwd never moves annotates (the positive control this pair rests on)", async () => {
  const repo = scratchRepo();
  try {
    const { envelope, result } = await runInProcess(repo, repo.plainFixture);
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const annotated = envelope.specs.filter((s) => s.status === "annotated");
    assert.equal(
      annotated.length,
      1,
      `the control MUST annotate or the chdir arm proves nothing: ${JSON.stringify(envelope.specs)}`,
    );
    assert.equal(annotated[0]!.line_number, repo.annotationLineOf(repo.plainFixture) + 1);
    assert.deepEqual(annotated[0]!.intent, {
      entity: "Cart",
      action: "apply promo code",
      behavior: "applies the discount when the code is valid",
      layer: "unit",
    });
  } finally {
    repo.cleanup();
  }
});

test("in-process: a mid-run chdir does not change the annotation — the repo root is bound once at run start", async () => {
  const repo = scratchRepo();
  try {
    const control = await runInProcess(repo, repo.plainFixture);
    const moved = await runInProcess(repo, repo.chdirFixture);

    assert.equal(moved.result.code, 0, `stderr: ${moved.result.stderr}`);

    // The fixtures are line-for-line identical apart from the chdir call, so
    // the (status, intent, file_path, line_number) shape must match exactly.
    // Pre-fix this arm shipped every row `unannotated` with `intent: null`.
    const shape = (e: Envelope): unknown =>
      e.specs
        .map((s) => ({
          file: s.file_path.replace(/^(plain|moves)\.test\.js$/, "FIXTURE.test.js"),
          line: s.line_number,
          status: s.status,
          intent: s.intent,
        }))
        .sort((a, b) => a.line - b.line);

    assert.deepEqual(shape(moved.envelope), shape(control.envelope));

    // ...and state the positive half directly, so a pair that degrades to
    // "neither annotates" fails here rather than passing on equality alone.
    assert.equal(moved.envelope.specs.filter((s) => s.status === "annotated").length, 1);
    // The row's own path stays repo-relative — a late root read relativized
    // it against `<root>/sub` and it fell back to the absolute path.
    assert.ok(
      moved.envelope.specs.every((s) => !s.file_path.startsWith("/")),
      `file paths must stay repo-relative: ${JSON.stringify(moved.envelope.specs.map((s) => s.file_path))}`,
    );
  } finally {
    repo.cleanup();
  }
});
