import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shipRun } from "../src/core/ship-run.js";
import type { RunnerEnv } from "../src/core/env.js";
import type { SpecRow } from "../src/core/types.js";

const ROW: SpecRow = {
  file_path: "test/alpha.test.js",
  line_number: 3,
  status: "unannotated",
  intent: null,
  name: "works",
  duration: 0.08,
  id: "id-1",
  outcome: "passed",
};

function env(overrides: Partial<RunnerEnv> = {}): RunnerEnv {
  return {
    commitSha: "abc123",
    branch: "main",
    ciRunId: "17",
    shardId: "0",
    endpoint: "http://127.0.0.1:1",
    apiKey: "sgk_test",
    repositoryId: null,
    timeoutMs: 500,
    outputPath: "/tmp/specguard-ts-test-ship-run-queue.jsonl",
    localOutputPath: "/tmp/specguard-ts-test-ship-run-local.jsonl",
    ...overrides,
  };
}

function collector(rows: SpecRow[]) {
  return { getRows: () => rows, durationSeconds: () => 1.5 };
}

/** Capture process.stderr.write for the duration of `fn`. */
async function captureStderr(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

const repoRoot = (): string => mkdtempSync(join(tmpdir(), "specguard-ship-run-"));

test("shipRun posts nothing and writes nothing for a zero-row run", async () => {
  let posts = 0;
  const appends: string[] = [];
  const stderr = await captureStderr(() =>
    shipRun(collector([]), {
      env: env(),
      repoRoot: repoRoot(),
      transport: {
        fetchImpl: (async () => {
          posts += 1;
          return new Response("{}", { status: 200 });
        }) as typeof fetch,
        appendFileImpl: async (_p, data) => {
          appends.push(data);
        },
      },
    }),
  );
  assert.equal(posts, 0);
  assert.deepEqual(appends, []);
  assert.deepEqual(stderr, []);
});

test("shipRun writes the no-sha line once and posts nothing when no commit sha resolves", async () => {
  let posts = 0;
  const stderr = await captureStderr(() =>
    shipRun(collector([ROW]), {
      env: env({ commitSha: null }),
      repoRoot: repoRoot(),
      transport: {
        fetchImpl: (async () => {
          posts += 1;
          return new Response("{}", { status: 200 });
        }) as typeof fetch,
        appendFileImpl: async () => {},
      },
    }),
  );
  assert.equal(posts, 0);
  assert.deepEqual(stderr, [
    "SpecGuard: no commit sha could be resolved (set SPECGUARD_COMMIT_SHA); telemetry not sent. The test run is unaffected.\n",
  ]);
});

test("shipRun delivers the collected row when a commit sha resolves", async () => {
  const bodies: string[] = [];
  await shipRun(collector([ROW]), {
    env: env({ endpoint: "http://127.0.0.1:9" }),
    repoRoot: repoRoot(),
    transport: {
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ""));
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      appendFileImpl: async () => {},
      warn: () => {},
    },
  });
  assert.equal(bodies.length, 1);
});

test("shipRun does not catch: a throwing collector propagates to the caller", async () => {
  await assert.rejects(
    shipRun(
      {
        getRows: () => {
          throw new Error("collector exploded");
        },
        durationSeconds: () => null,
      },
      { env: env(), repoRoot: repoRoot() },
    ),
    /collector exploded/,
  );
});
