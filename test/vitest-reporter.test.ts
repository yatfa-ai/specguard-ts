import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const { join, dirname } = path;

import {
  SpecguardVitestReporter,
  type VitestReporterOptions,
} from "../src/vitest/reporter.js";
import type { VitestTestCase, VitestTestModule } from "../src/vitest/collector.js";
import type { RunnerEnv } from "../src/core/env.js";
import type { Envelope } from "../src/core/types.js";
import { SCHEMA_CONTRACT_DIGEST, VALIDATE_INTENT_ENV_VAR } from "../src/core/validator.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function env(overrides: Partial<RunnerEnv> = {}): RunnerEnv {
  return {
    commitSha: "abc123",
    branch: "main",
    ciRunId: "17",
    shardId: "0",
    endpoint: "https://specguard.example.com",
    apiKey: "sgk_test",
    timeoutMs: 1000,
    outputPath: "log/test_results.jsonl",
    ...overrides,
  };
}

function vitestTest(name: string, line: number): VitestTestCase {
  return {
    type: "test",
    name,
    fullName: name,
    location: { line, column: 3 },
    result: () => ({ state: "passed" }),
    diagnostic: () => ({ duration: 250 }),
  };
}

function moduleOf(tests: VitestTestCase[], moduleId = join(pkgRoot, "fixtures", "vitest", "mixed.test.ts")): VitestTestModule {
  return {
    type: "module",
    moduleId,
    children: { allTests: () => tests[Symbol.iterator]() },
  };
}

interface Seen {
  url: string;
  body: Envelope;
}

/** Run one reporter over `modules` with an intercepting transport. */
async function runReporter(
  modules: VitestTestModule[],
  options: Partial<VitestReporterOptions> = {},
): Promise<{ seen: Seen[]; sink: string[]; stderr: string[] }> {
  const seen: Seen[] = [];
  const sink: string[] = [];
  const stderr: string[] = [];
  const origWrite = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const reporter = new SpecguardVitestReporter({
      env: env(),
      repoRoot: pkgRoot,
      transport: {
        fetchImpl: (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
          seen.push({ url: String(url), body: JSON.parse(String(init?.body)) as Envelope });
          return new Response("{}", { status: 202 });
        }) as unknown as typeof fetch,
        appendFileImpl: async (_p: string, data: string) => {
          sink.push(data);
        },
      },
      ...options,
    });
    await reporter.onTestRunEnd(modules);
    return { seen, sink, stderr };
  } finally {
    process.stderr.write = origWrite;
  }
}

test("the reporter collects rows and POSTs one envelope through the transport", async () => {
  const { seen } = await runReporter([
    moduleOf([vitestTest("outer > child ok", 5), vitestTest("outer > child failing", 9)]),
  ]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "https://specguard.example.com/api/v1/ingest");
  const body = seen[0]!.body;
  assert.equal(body.commit_sha, "abc123");
  assert.equal(body.specs.length, 2);
  assert.equal(body.specs[0]!.file_path, "fixtures/vitest/mixed.test.ts");
  assert.equal(body.specs[0]!.duration, 0.25); // 250 ms -> seconds
  assert.equal(typeof body.duration_seconds, "number");
});

test("a run that reported zero tests POSTs nothing and writes nothing", async () => {
  const { seen, sink } = await runReporter([moduleOf([])]);
  assert.equal(seen.length, 0);
  assert.equal(sink.length, 0);
});

test("dropped rows (no location) warn on stderr naming includeTaskLocation", async () => {
  const { stderr, seen } = await runReporter([
    moduleOf([{ ...vitestTest("no-loc", 1), location: null }]),
  ]);
  assert.equal(seen.length, 0); // every row dropped -> zero rows -> no POST
  assert.ok(stderr.some((line) => line.includes("dropped 1") && line.includes("includeTaskLocation")), stderr.join(""));
});

test("no commit sha: one stderr line, no POST, no crash", async () => {
  const { seen, stderr } = await runReporter([moduleOf([vitestTest("a", 1)])], {
    env: env({ commitSha: null }),
  });
  assert.equal(seen.length, 0);
  assert.ok(stderr.some((l) => l.includes("no commit sha")), stderr.join(""));
});

test("the annotation pass runs through the unchanged shared path", async (t) => {
  // A temp "repo" with one annotated source, and a stub backend that ratifies
  // the annotation at its COMMENT line — the same fixture discipline as
  // test/annotate.test.ts, proving the vitest reporter feeds annotateRows.
  const repo = fs.mkdtempSync(join(os.tmpdir(), "specguard-vitest-reporter-"));
  const source = join(repo, "annotated.test.ts");
  const lines = [
    'import { test } from "vitest";',
    "",
    '// @intent: {"entity":"Cart","action":"apply promo code","behavior":"applies the discount","layer":"unit"}',
    'test("applies", () => {});',
    "",
  ];
  fs.writeFileSync(source, lines.join("\n") + "\n");
  const doc = JSON.stringify({
    mode: "source",
    findings: [
      {
        file: source,
        line: 3,
        kind: "schema",
        ok: true,
        errors: [],
        intent: { entity: "Cart", action: "apply promo code", behavior: "applies the discount", layer: "unit" },
      },
    ],
    summary: { annotations: 1 },
  });
  const bin = join(repo, "validate-intent");
  fs.writeFileSync(
    bin,
    [
      "#!/bin/sh",
      "case \"$1\" in",
      `  --version) printf '%s\\n' 'validate-intent stub (vitest-reporter) schema sha256:${SCHEMA_CONTRACT_DIGEST}'; exit 0 ;;`,
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

  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  const { seen } = await runReporter(
    [
      {
        type: "module",
        moduleId: source,
        children: { allTests: () => [vitestTest("applies", 4)][Symbol.iterator]() },
      },
    ],
    {
      repoRoot: repo,
      validator: { env: { [VALIDATE_INTENT_ENV_VAR]: bin } },
    },
  );
  assert.equal(seen.length, 1);
  const row = seen[0]!.body.specs[0]!;
  assert.equal(row.name, "applies");
  assert.equal(row.status, "annotated");
  assert.deepEqual(row.intent, {
    entity: "Cart",
    action: "apply promo code",
    behavior: "applies the discount",
    layer: "unit",
  });
});

test("never-fail: a poison module cannot throw out of onTestRunEnd", async () => {
  const origWrite = process.stderr.write;
  const stderr: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const reporter = new SpecguardVitestReporter({ env: env(), repoRoot: pkgRoot });
    // allTests itself throwing is contained by the collector; make the
    // ENVELOPE path hostile instead: modules whose iterator poisons on read
    // after the first entry — plus a getter that throws on moduleId.
    const poison = [
      {
        get moduleId(): string {
          throw new Error("boom");
        },
        children: { allTests: () => [vitestTest("x", 1)][Symbol.iterator]() },
      },
    ];
    await reporter.onTestRunEnd(poison as unknown as VitestTestModule[]);
    assert.ok(stderr.some((l) => l.includes("unaffected")), stderr.join(""));
  } finally {
    process.stderr.write = origWrite;
  }
});

test("the constructor never throws: junk arguments degrade to defaults", () => {
  // Vitest instantiates with an options object; a hostile or absent one
  // still must produce a usable reporter.
  const fromUndefined = new (SpecguardVitestReporter as unknown as new (o?: unknown) => SpecguardVitestReporter)();
  assert.ok(fromUndefined instanceof SpecguardVitestReporter);
  const fromNull = new (SpecguardVitestReporter as unknown as new (o?: unknown) => SpecguardVitestReporter)(null);
  assert.ok(fromNull instanceof SpecguardVitestReporter);
});

test("the Vitest <= 3 onFinished hook warns loudly instead of shipping silently", async () => {
  const origWrite = process.stderr.write;
  const stderr: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const reporter = new SpecguardVitestReporter({ env: env(), repoRoot: pkgRoot });
    (reporter as unknown as { onFinished: () => void }).onFinished();
    assert.ok(
      stderr.some((l) => l.includes("Vitest >= 4") && l.includes("telemetry not sent")),
      stderr.join(""),
    );
  } finally {
    process.stderr.write = origWrite;
  }
});
