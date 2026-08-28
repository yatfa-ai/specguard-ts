import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import type { Envelope } from "../src/core/types.js";

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
    assert.match(req.userAgent ?? "", /^specguard-ts\//);
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

    // duration — seconds: the 80ms sleep lands in [0.05, 0.5], not near 80
    const slept = byName.get("passing suite > child ok")?.duration;
    assert.ok(
      slept !== null && slept !== undefined && slept >= 0.05 && slept <= 0.5,
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

test("no API key: the run is written to the local sink and nothing is sent", async () => {
  const srv = await captureServer();
  const tmp = mkdtempSync(join(tmpdir(), "specguard-ts-"));
  try {
    const result = await runNodeTest("mixed.test.js", srv.url, {
      SPECGUARD_API_KEY: "",
      SPECGUARD_OUTPUT_PATH: join(tmp, "out.jsonl"),
    });
    assert.equal(srv.captured.length, 0);
    const written = readFileSync(join(tmp, "out.jsonl"), "utf8").trim().split("\n");
    assert.equal(written.length, 1);
    const parsed = JSON.parse(written[0]!) as Envelope;
    assert.equal(parsed.specs.length, 4);
    assert.equal(parsed.commit_sha, "deadbeef");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    await srv.close();
  }
});
