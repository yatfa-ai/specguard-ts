import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deliver, deliverRawLine, GZIP_THRESHOLD_BYTES, refusalReasons, version } from "../src/core/transport.js";
import type { RunnerEnv } from "../src/core/env.js";
import type { Envelope } from "../src/core/types.js";
import type { SpecRow } from "../src/core/types.js";

function envelope(): Envelope {
  const row: SpecRow = {
    file_path: "test/alpha.test.js",
    line_number: 3,
    status: "unannotated",
    intent: null,
    name: "works",
    duration: 0.08,
    id: "id-1",
    outcome: "passed",
  };
  return {
    commit_sha: "abc123",
    branch: "main",
    ci_run_id: "17",
    shard_id: "0",
    duration_seconds: 1.5,
    specs: [row],
  };
}

function env(overrides: Partial<RunnerEnv> = {}): RunnerEnv {
  return {
    commitSha: "abc123",
    branch: "main",
    ciRunId: "17",
    shardId: "0",
    endpoint: "http://127.0.0.1:1", // connection-refused port by default
    apiKey: "sgk_test",
    timeoutMs: 500,
    outputPath: "/tmp/specguard-ts-test-replay-queue.jsonl",
    localOutputPath: "/tmp/specguard-ts-test-local-sink.jsonl",
    ...overrides,
  };
}

interface Sink {
  writes: string[];
  warn: (msg: string) => void;
  warnings: string[];
  appendFile: (path: string, data: string) => Promise<void>;
}

function sink(): Sink {
  const s: Sink = {
    writes: [],
    warnings: [],
    warn: (msg) => s.warnings.push(msg),
    appendFile: async (path, data) => {
      s.writes.push(`${path}::${data}`);
    },
  };
  return s;
}

async function startServer(
  handler: http.RequestListener,
): Promise<{ server: http.Server; url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve(undefined));
        server.closeAllConnections();
      }),
  };
}

test("never-fail: an unreachable host resolves, warns once, falls back — never throws", async () => {
  const s = sink();
  const result = await deliver(envelope(), env(), {
    warn: s.warn,
    appendFileImpl: s.appendFile,
  });
  assert.equal(result.delivered, false);
  assert.equal(result.outcome, "fell-back");
  assert.equal(s.warnings.length, 1);
  assert.match(s.warnings[0] ?? "", /SpecGuard: could not deliver test telemetry/);
  assert.equal(s.writes.length, 1);
  assert.match(s.writes[0] ?? "", /commit_sha/);
});

test("never-fail: a timeout resolves, warns once, falls back — never throws", async () => {
  const srv = await startServer(() => {
    // Accept the connection, never respond.
  });
  try {
    const s = sink();
    const result = await deliver(envelope(), env({ endpoint: srv.url, timeoutMs: 200 }), {
      warn: s.warn,
      appendFileImpl: s.appendFile,
    });
    assert.equal(result.delivered, false);
    assert.equal(result.outcome, "fell-back");
    assert.ok((s.warnings[0] ?? "").includes("timeout"), s.warnings[0]);
  } finally {
    await srv.close();
  }
});

test("never-fail: a 401 resolves (fetch does NOT throw), warns, falls back — never throws", async () => {
  const srv = await startServer((req, res) => {
    res.statusCode = 401;
    res.end("unauthorized");
  });
  try {
    const s = sink();
    const result = await deliver(envelope(), env({ endpoint: srv.url }), {
      warn: s.warn,
      appendFileImpl: s.appendFile,
    });
    assert.equal(result.delivered, false);
    assert.equal(result.outcome, "fell-back");
    assert.match(s.warnings[0] ?? "", /HTTP 401/);
  } finally {
    await srv.close();
  }
});

test("never-fail: a 500 resolves (fetch does NOT throw), warns, falls back — never throws", async () => {
  const srv = await startServer((req, res) => {
    res.statusCode = 500;
    res.end("internal server error");
  });
  try {
    const s = sink();
    const result = await deliver(envelope(), env({ endpoint: srv.url }), {
      warn: s.warn,
      appendFileImpl: s.appendFile,
    });
    assert.equal(result.delivered, false);
    assert.equal(result.outcome, "fell-back");
    assert.match(s.warnings[0] ?? "", /HTTP 500/);
  } finally {
    await srv.close();
  }
});

test("a 202 is delivered: no warning, no fallback write", async () => {
  let seen: { status: number; auth: string | undefined; body: string } | undefined;
  const srv = await startServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += String(chunk)));
    req.on("end", () => {
      seen = { status: req.statusCode ?? 0, auth: req.headers.authorization, body };
      res.statusCode = 202;
      res.end('{"test_run_id":"41f2c9b8"}');
    });
  });
  try {
    const s = sink();
    const result = await deliver(envelope(), env({ endpoint: srv.url }), {
      warn: s.warn,
      appendFileImpl: s.appendFile,
    });
    assert.deepEqual(result, { delivered: true, outcome: "sent" });
    assert.equal(s.warnings.length, 0);
    assert.equal(s.writes.length, 0);
    assert.ok(seen !== undefined);
    assert.equal(seen.auth, "Bearer sgk_test");
    assert.ok(seen.body.includes('"ci_run_id":"17"'));
  } finally {
    await srv.close();
  }
});


test("the request carries User-Agent specguard-ts/<version>", async () => {
  let ua: string | undefined;
  const srv = await startServer((req, res) => {
    ua = req.headers["user-agent"];
    res.statusCode = 202;
    res.end("{}");
  });
  try {
    await deliver(envelope(), env({ endpoint: srv.url }), { warn: () => {}, appendFileImpl: async () => {} });
    assert.equal(ua, `specguard-ts/${version()}`);
  } finally {
    await srv.close();
  }
});

test("a body over the 256 KiB threshold is sent gzipped", async () => {
  let encoding: string | undefined;
  let bytes = 0;
  const srv = await startServer((req, res) => {
    encoding = req.headers["content-encoding"];
    req.on("data", (chunk) => (bytes += chunk.length));
    req.on("end", () => {
      res.statusCode = 202;
      res.end("{}");
    });
  });
  try {
    const big = envelope();
    // ~300 KiB of names: comfortably past GZIP_THRESHOLD_BYTES.
    const filler = "x".repeat(300);
    big.specs = Array.from({ length: Math.ceil((GZIP_THRESHOLD_BYTES + 4096) / 340) }, (_, i) => ({
      ...big.specs[0]!,
      name: `test ${i} ${filler}`,
      id: `id-${i}`,
    }));
    const result = await deliver(big, env({ endpoint: srv.url }), {
      warn: () => {},
      appendFileImpl: async () => {},
    });
    assert.equal(result.delivered, true);
    assert.equal(encoding, "gzip");
    // Gzipped length must be far below the raw JSON length.
    assert.ok(bytes < GZIP_THRESHOLD_BYTES, `sent ${bytes} bytes uncompressed?`);
  } finally {
    await srv.close();
  }
});

test("no API key: nothing is sent anywhere, the run goes to the LOCAL sink, silently", async () => {
  const s = sink();
  const result = await deliver(envelope(), env({ apiKey: null }), {
    warn: s.warn,
    appendFileImpl: s.appendFile,
  });
  assert.deepEqual(result, { delivered: false, outcome: "skipped" });
  assert.equal(s.warnings.length, 0);
  assert.equal(s.writes.length, 1);
  // The keyless run is a laptop run, not a failed delivery: it lands in the
  // local development record, and the replay queue is NOT touched.
  assert.match(s.writes[0] ?? "", /^\/tmp\/specguard-ts-test-local-sink\.jsonl::/);
  assert.match(s.writes[0] ?? "", /commit_sha/);
});

// --- SPGD-1446: the keyless failure arm is documented ------------------------
//
// The keyless write has a failure arm: when the local record cannot be
// written, `deliver` prints ONE stderr line naming the configured path and the
// underlying error, and the run is unaffected — the outcome stays "skipped"
// and the replay queue is never touched. The README documented the success
// arm only. The seal below is extraction-based (the d045e53 template): it
// EXTRACTS the emitted line and asserts the README carries it verbatim, so it
// fails against any README that does not document this arm — no expectation
// assembled only from tokens the README already contained can pass vacuously.
// The driver is `new Error("closed stream")` deliberately: its message
// carries no path, so the path in the emitted line can only be the configured
// `localOutputPath`.

test("SPGD-1446: the keyless write-failure line is documented in the README", async () => {
  const s = sink();
  const result = await deliver(
    envelope(),
    env({ apiKey: null, localOutputPath: "log/test_results.local.jsonl" }),
    {
      warn: s.warn,
      appendFileImpl: async () => {
        throw new Error("closed stream");
      },
    },
  );
  // The failure arm changes nothing about the delivery result: the outcome is
  // still "skipped", and the replay queue is never touched.
  assert.deepEqual(result, { delivered: false, outcome: "skipped" });
  assert.equal(s.writes.length, 0);
  // Exactly one warning — the failure line itself, no more.
  assert.equal(s.warnings.length, 1);
  // THE SEAL: extract the emitted line and assert the README carries it
  // verbatim. Whitespace is collapsed on both sides because the README wraps
  // its sample blocks; everything else must match byte for byte.
  const emitted = s.warnings[0] ?? "";
  const readme = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "README.md"),
    "utf8",
  );
  const flat = (text: string): string => text.replace(/\s+/g, " ").trim();
  assert.ok(
    flat(readme).includes(flat(emitted)),
    `README.md must document the keyless failure line verbatim; emitted:\n${emitted}`,
  );
});

test("the two sinks are separate files: a refused delivery lands in the replay queue ONLY", async () => {
  // The pin behind the split: keyless runs and failed deliveries must never
  // share a file, because nothing on a written line says which sink it was
  // destined for and a mixed file can never be separated after the fact.
  const srv = await startServer((req, res) => {
    res.statusCode = 401;
    res.end("unauthorized");
  });
  try {
    const s = sink();
    const result = await deliver(envelope(), env({ endpoint: srv.url }), {
      warn: s.warn,
      appendFileImpl: s.appendFile,
    });
    assert.equal(result.outcome, "fell-back");
    assert.equal(s.writes.length, 1);
    assert.match(s.writes[0] ?? "", /^\/tmp\/specguard-ts-test-replay-queue\.jsonl::/,
      "a failed delivery is replay-queue material, never local-sink material");
  } finally {
    await srv.close();
  }
});

test("a fallback write that itself fails only warns — never throws", async () => {
  const s = sink();
  const result = await deliver(envelope(), env(), {
    warn: s.warn,
    appendFileImpl: async () => {
      throw new Error("disk full");
    },
  });
  assert.equal(result.delivered, false);
  assert.equal(s.warnings.length, 2); // delivery failure + write failure
  assert.match(s.warnings[1] ?? "", /could not write telemetry/);
});

// --- SPGD-1418: the double-failure arm must speak ----------------------------
//
// The test above drives this very arm and stayed green through the defect:
// every clause it pins (`SpecGuard:`, the warning count, `could not write
// telemetry`) is true on both the broken and the fixed code, because the
// defect was not a missing line — it was a LYING line ("The test run is
// unaffected.", printed twice) plus a false promise ("Falling back to <path>")
// and a false outcome ("fell-back") for a run that went nowhere. The pins
// below therefore assert on bytes that DIFFER: the absence of "unaffected"
// anywhere in the output, and the presence of the loss statement and the
// queue path. They exist on both transport arms because the fix restructured
// both call sites; reverting either one alone must fail its own pin.

test("SPGD-1418: a refused delivery whose replay write also fails names the loss — the output never claims the run is unaffected", async () => {
  const srv = await startServer((req, res) => {
    res.statusCode = 401;
    res.end("unauthorized");
  });
  try {
    const s = sink();
    const result = await deliver(envelope(), env({ endpoint: srv.url }), {
      warn: s.warn,
      appendFileImpl: async () => {
        throw new Error("EEXIST: file already exists, mkdir '/tmp/p2/blocker'");
      },
    });
    // The outcome must not report a fall-back that did not happen.
    assert.equal(result.delivered, false);
    assert.equal(result.outcome, "lost");
    // THE LOAD-BEARING ASSERTIONS — both false on the unfixed code:
    assert.ok(
      !s.warnings.join("\n").includes("unaffected"),
      `the double-failure output must not claim the run is unaffected:\n${s.warnings.join("\n")}`,
    );
    assert.match(s.warnings.join("\n"), /telemetry was lost/);
    // The queue path that was NOT written is named, and the actionable status
    // clause survives.
    assert.match(s.warnings.join("\n"), /specguard-ts-test-replay-queue\.jsonl/);
    assert.match(s.warnings.join("\n"), /HTTP 401/);
    // Shape (descriptive, not load-bearing — true before and after): the
    // status clause alone, then the loss line.
    assert.equal(s.warnings.length, 2);
    assert.match(s.warnings[0] ?? "", /HTTP 401/);
    assert.doesNotMatch(s.warnings[0] ?? "", /Falling back/);
    assert.match(s.warnings[1] ?? "", /telemetry was lost/);
    // And nothing was written anywhere.
    assert.equal(s.writes.length, 0);
  } finally {
    await srv.close();
  }
});

test("SPGD-1418: the same loss on the network arm — an unreachable endpoint and an unwritable queue never claim the run is unaffected", async () => {
  const s = sink();
  const result = await deliver(envelope(), env(), {
    warn: s.warn,
    appendFileImpl: async () => {
      throw new Error("EEXIST: file already exists, mkdir '/tmp/p2/blocker'");
    },
  });
  assert.equal(result.delivered, false);
  assert.equal(result.outcome, "lost");
  assert.ok(
    !s.warnings.join("\n").includes("unaffected"),
    `the double-failure output must not claim the run is unaffected:\n${s.warnings.join("\n")}`,
  );
  assert.match(s.warnings.join("\n"), /telemetry was lost/);
  assert.match(s.warnings.join("\n"), /specguard-ts-test-replay-queue\.jsonl/);
  assert.match(s.warnings.join("\n"), /could not deliver test telemetry/);
  assert.equal(s.writes.length, 0);
});

test("SPGD-1418: append rejecting with null itself still names the loss — the write-failure discriminator is presence, not a sentinel value", async () => {
  // TransportDeps.appendFileImpl is public injectable API and its rejection
  // value is outside this package's control. A `throw null` is the exact
  // input that impersonated "no error" under a `writeError: unknown = null`
  // sentinel: the loss line was skipped, the promise line printed, and the
  // outcome read "fell-back" for a write that never happened. Presence must
  // be carried separately from the value.
  const s = sink();
  const result = await deliver(envelope(), env(), {
    warn: s.warn,
    appendFileImpl: async () => {
      throw null;
    },
  });
  assert.equal(result.delivered, false);
  // A null rejection IS a failed write: the outcome must not claim a
  // fall-back that did not happen.
  assert.equal(result.outcome, "lost");
  assert.ok(
    !s.warnings.join("\n").includes("unaffected"),
    `a null rejection must not resurrect the promise line:\n${s.warnings.join("\n")}`,
  );
  assert.match(s.warnings.join("\n"), /telemetry was lost/);
  // The write's rejection renders as its own value, so the operator sees
  // WHAT rejected, not only that something did.
  assert.match(s.warnings.join("\n"), /could not write telemetry to .* \(null\), so this run's telemetry was lost\./);
  assert.match(s.warnings.join("\n"), /specguard-ts-test-replay-queue\.jsonl/);
  assert.equal(s.writes.length, 0);
});

test("SPGD-1418: the successful fall-back sentence is single-sourced — pinned byte for byte at that one site", async () => {
  // Before the fallBackToQueue extraction this sentence was composed at two
  // call sites; now fallBackToQueue is the single point of failure for its
  // exact bytes, so the composition carries its own guard. The successful
  // path's sentence — the one line whose bytes AC3 froze against
  // origin/main — must never drift silently.
  const srv = await startServer((req, res) => {
    res.statusCode = 401;
    res.end("unauthorized");
  });
  try {
    const base = env({ endpoint: srv.url });
    const s = sink();
    const result = await deliver(envelope(), base, {
      warn: s.warn,
      appendFileImpl: s.appendFile,
    });
    assert.equal(result.delivered, false);
    assert.equal(result.outcome, "fell-back");
    assert.equal(s.warnings.length, 1);
    assert.equal(
      s.warnings[0],
      `SpecGuard: could not deliver test telemetry (HTTP 401 — unauthorized). Falling back to ${base.outputPath}; the test run is unaffected.`,
    );
    assert.equal(s.writes.length, 1);
  } finally {
    await srv.close();
  }
});

// --- SPGD-1188: version() must resolve the REAL package version --------------
//
// Until SPGD-1195 the UA test above pinned only /^specguard-ts\//, which is
// why a pre-existing defect survived: the old fixed "../package.json" read
// resolved against <pkg>/dist/core, named <pkg>/dist/package.json, never
// existed, and every built layout (dist, npm install, the test build) answered
// the "0.0.0" fallback — every delivery advertised specguard-ts/0.0.0. The UA
// test now pins the full `specguard-ts/${version()}` value (SPGD-1195), and
// this pin holds the identity line (and the User-Agent value) to the
// manifest's truth.

test("version() resolves the package manifest's own version in the compiled layout", () => {
  const pkg = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8"),
  ) as { version: string };
  assert.match(version(), /^\d+\.\d+\.\d+$/);
  assert.equal(version(), pkg.version);
});

// --- SPGD-1226: the refusal parse --------------------------------------------
//
// The platform answers a 400 with ONE error per offending spec
// (`render_bad_request` puts every one of them in `details`). The raw-text
// `detail` flattens that to 300 characters — right for the one CI-warning
// line it is, useless for the command whose job is to fix and re-send the
// run. `refusalReasons` keeps the whole array, parsed off the SAME single
// body read, degrading to null on anything unreadable — never a new failure
// mode on the never-throw path. The predicates are the Ruby Transport's
// `refusal_reasons`, ported exactly.

/** A `render_bad_request`-shaped body; `null` omits the key entirely. */
function refusalBody(details: unknown, message: string | null = null): string {
  const body: Record<string, unknown> = { error: "bad_request" };
  if (message !== null) body.message = message;
  if (details !== null) body.details = details;
  return JSON.stringify(body);
}

test("SPGD-1226: a 400 carrying details of N strings yields reasons of length N — uncapped, in the platform's order (N ≫ 3)", async () => {
  const specs = Array.from({ length: 25 }, (_, i) =>
    `specs[${i}] test/a.test.js:${100 + i}: duration must be a non-negative number when present`,
  );
  const srv = await startServer((req, res) => {
    res.statusCode = 400;
    res.end(refusalBody(specs, specs[0]!));
  });
  try {
    const result = await deliverRawLine(JSON.stringify(envelope()), env({ endpoint: srv.url }));
    assert.equal(result.outcome, "http-error");
    assert.equal(result.status, 400);
    assert.deepEqual(result.reasons, specs);
    assert.ok(result.reasons !== null && result.reasons.length === 25,
      "the cap is a render-time concern of the human line; the parse keeps every reason");
    // The structured list and the flattened line are two halves of ONE read:
    // detail stays today's truncated one-liner, byte for byte.
    assert.ok(result.detail.endsWith("…"), result.detail);
    assert.ok(result.detail.length <= 301);
    assert.ok(!result.detail.includes("\n"));
  } finally {
    await srv.close();
  }
});

test("SPGD-1226: a message-only body is a single-entry fallback", async () => {
  const srv = await startServer((req, res) => {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "bad_request", message: "specs is required and must be an array" }));
  });
  try {
    const result = await deliverRawLine("{}", env({ endpoint: srv.url }));
    assert.equal(result.outcome, "http-error");
    assert.deepEqual(result.reasons, ["specs is required and must be an array"]);
    // `detail` is unchanged: the flattened FULL body, not the message.
    assert.equal(result.detail, '{"error":"bad_request","message":"specs is required and must be an array"}');
  } finally {
    await srv.close();
  }
});

test("SPGD-1226: details that are not a non-empty all-string array fall through to message, then to null", async () => {
  const cases: { body: string; want: string[] | null }[] = [
    { body: refusalBody(["ok", 42], "mixed types"), want: ["mixed types"] },
    { body: refusalBody([], "empty details"), want: ["empty details"] },
    { body: refusalBody("not an array", "details not an array"), want: ["details not an array"] },
    { body: refusalBody([["nested"], 1], "still mixed"), want: ["still mixed"] },
    { body: refusalBody(["ok", 42]), want: null }, // no message either
    { body: refusalBody([]), want: null },
    { body: refusalBody(null), want: null }, // no details, no message
  ];
  for (const { body, want } of cases) {
    const srv = await startServer((req, res) => {
      res.statusCode = 400;
      res.end(body);
    });
    try {
      const result = await deliverRawLine("{}", env({ endpoint: srv.url }));
      assert.equal(result.outcome, "http-error");
      assert.deepEqual(result.reasons, want, body);
    } finally {
      await srv.close();
    }
  }
});

test("SPGD-1226: a refusal body that is not JSON, is a JSON scalar, or is empty degrades to today's detail — no new failure mode", async () => {
  const cases: string[] = [
    "<html>413 Request Entity Too Large</html>",
    "boom",
    "42",
    '"just a string"',
    "null",
    "true",
    "[]",
    "",
  ];
  for (const body of cases) {
    const srv = await startServer((req, res) => {
      res.statusCode = 400;
      res.end(body);
    });
    try {
      const result = await deliverRawLine("{}", env({ endpoint: srv.url }));
      assert.equal(result.outcome, "http-error");
      assert.equal(result.reasons, null, JSON.stringify(body));
      // The detail is today's byte-exact rendering — whitespace flattened,
      // hard-truncated at 300 with an ellipsis — computed here independently
      // of the implementation so the pin cannot rot with it.
      const flattened = body.replace(/\s+/g, " ").trim();
      const want = flattened.length > 300 ? `${flattened.slice(0, 300)}…` : flattened;
      assert.equal(result.detail, want, JSON.stringify(body));
    } finally {
      await srv.close();
    }
  }
});

test("SPGD-1226: refusalReasons — the Ruby twin's predicate matrix, unit-pinned", () => {
  const details = Array.from({ length: 12 }, (_, i) => `specs[${i}] x.test.js:1`);
  assert.deepEqual(refusalReasons(JSON.stringify({ error: "bad_request", details })), details);
  assert.deepEqual(refusalReasons(JSON.stringify({ message: "only a message" })), ["only a message"]);
  assert.deepEqual(refusalReasons('{"message":"m","details":["a"]}'), ["a"]);
  assert.equal(refusalReasons("{}"), null); // no details, no message
  assert.equal(refusalReasons("not json"), null);
  assert.equal(refusalReasons(""), null);
  assert.equal(refusalReasons("null"), null);
  assert.equal(refusalReasons("[]"), null);
  assert.equal(refusalReasons("7"), null);
  assert.equal(refusalReasons('"s"'), null);
  assert.equal(refusalReasons('{"details":"a string"}'), null);
});
