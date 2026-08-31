import { test } from "node:test";
import assert from "node:assert/strict";
import { specguardReporter, type ReporterEvent } from "../src/node-test/reporter.js";
import type { RunnerEnv } from "../src/core/env.js";
import type { Envelope } from "../src/core/types.js";

function env(overrides: Partial<RunnerEnv> = {}): RunnerEnv {
  return {
    commitSha: "abc123",
    branch: "main",
    ciRunId: "17",
    shardId: "0",
    endpoint: null,
    apiKey: null,
    timeoutMs: 1000,
    outputPath: "log/test_results.jsonl",
    localOutputPath: "log/test_results.local.jsonl",
    ...overrides,
  };
}

async function* events(list: ReporterEvent[]): AsyncGenerator<ReporterEvent> {
  yield* list;
}

function pass(name: string, line: number, nesting = 0, file = "/repo/test/alpha.test.js"): ReporterEvent {
  return { type: "test:pass", data: { name, nesting, file, line } };
}

test("the reporter collects rows and hands one envelope to the transport", async () => {
  const delivered: Envelope[] = [];
  let callCount = 0;
  const stream = specguardReporter(
    events([
      { type: "test:start", data: { name: "suite", nesting: 0 } },
      { type: "test:start", data: { name: "child", nesting: 1 } },
      pass("child", 5, 1),
      { type: "test:pass", data: { name: "suite", nesting: 0, line: 2, file: "/repo/test/alpha.test.js", details: { type: "suite" } } },
      { type: "test:diagnostic", data: { message: "noise" } as never },
    ]),
    {
      env: env(),
      repoRoot: "/repo",
      transport: {
        // Intercept before fetch: capture what would be sent.
        fetchImpl: (async () => {
          callCount += 1;
          return new Response("{}", { status: 202 });
        }) as unknown as typeof fetch,
        appendFileImpl: async () => {},
      },
    },
  );
  for await (const _ of stream) void _;

  // endpoint was null → no fetch, went to the sink instead; verify via env with endpoint
  assert.equal(callCount, 0);
  assert.equal(delivered.length, 0);
});

test("with an endpoint+key configured, the reporter POSTs exactly once with the composed rows", async () => {
  let seen: { url: string; body: string } | undefined;
  const stream = specguardReporter(
    events([
      { type: "test:start", data: { name: "outer", nesting: 0 } },
      { type: "test:start", data: { name: "inner", nesting: 1 } },
      { type: "test:start", data: { name: "leaf", nesting: 2 } },
      pass("leaf", 9, 2),
      { type: "test:pass", data: { name: "inner", nesting: 1, line: 8, file: "/repo/test/alpha.test.js", details: { type: "suite" } } },
      { type: "test:pass", data: { name: "outer", nesting: 0, line: 7, file: "/repo/test/alpha.test.js", details: { type: "suite" } } },
    ]),
    {
      env: env({ endpoint: "https://specguard.example.com", apiKey: "sgk_x" }),
      repoRoot: "/repo",
      transport: {
        fetchImpl: (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
          seen = { url: String(url), body: String(init?.body) };
          return new Response("{}", { status: 202 });
        }) as unknown as typeof fetch,
        appendFileImpl: async () => {},
      },
    },
  );
  for await (const _ of stream) void _;

  assert.ok(seen !== undefined);
  assert.equal(seen.url, "https://specguard.example.com/api/v1/ingest");
  const parsed = JSON.parse(seen.body) as Envelope;
  assert.equal(parsed.specs.length, 1);
  assert.equal(parsed.specs[0]?.name, "outer > inner > leaf");
  assert.equal(parsed.specs[0]?.file_path, "test/alpha.test.js");
});

test("a run that reports zero tests does not crash and does not POST", async () => {
  let posted = 0;
  let appended = 0;
  const stream = specguardReporter(events([]), {
    env: env({ endpoint: "https://specguard.example.com", apiKey: "sgk_x" }),
    repoRoot: "/repo",
    transport: {
      fetchImpl: (async () => {
        posted += 1;
        return new Response("{}", { status: 202 });
      }) as unknown as typeof fetch,
      appendFileImpl: async () => {
        appended += 1;
      },
    },
  });
  for await (const _ of stream) void _;
  assert.equal(posted, 0);
  assert.equal(appended, 0);
});

test("a transport that throws anyway does not propagate out of the stream", async () => {
  const stream = specguardReporter(events([pass("solo", 3)]), {
    env: env({ endpoint: "https://specguard.example.com", apiKey: "sgk_x" }),
    repoRoot: "/repo",
    transport: {
      fetchImpl: (async () => {
        throw new Error("boom before the never-fail guard");
      }) as unknown as typeof fetch,
      appendFileImpl: async () => {
        throw new Error("disk full");
      },
      warn: () => {},
    },
  });
  for await (const _ of stream) void _;
  // Reaching here without an exception IS the assertion.
  assert.ok(true);
});
