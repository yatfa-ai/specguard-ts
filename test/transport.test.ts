import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { deliver, GZIP_THRESHOLD_BYTES } from "../src/core/transport.js";
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
    assert.match(ua ?? "", /^specguard-ts\//);
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
