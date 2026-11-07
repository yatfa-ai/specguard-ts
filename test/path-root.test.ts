import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveRunRoots } from "../src/core/path-root.js";
import { specguardReporter } from "../src/node-test/reporter.js";
import { SpecguardVitestReporter } from "../src/vitest/reporter.js";
import { SpecguardJestReporter } from "../src/jest/reporter.js";
import type { RunnerEnv } from "../src/core/env.js";
import type { Envelope } from "../src/core/types.js";
import { SCHEMA_CONTRACT_DIGEST, VALIDATE_INTENT_ENV_VAR } from "../src/core/validator.js";

function env(): RunnerEnv {
  return {
    commitSha: "abc123",
    branch: "main",
    ciRunId: "17",
    shardId: "0",
    endpoint: "https://specguard.example.com",
    apiKey: "sgk_test",
    repositoryId: null,
    timeoutMs: 1000,
    outputPath: "log/test_results.jsonl",
    localOutputPath: "log/test_results.local.jsonl",
  };
}

function tmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "specguard-pathroot-")));
}

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
}

const INTENT = { entity: "Util", action: "format", behavior: "formats a value", layer: "unit" };
const SOURCE = [
  "import { test } from 'node:test';",
  `// @intent: ${JSON.stringify(INTENT)}`,
  "test('formats', () => {});",
  "",
].join("\n");
const COMMENT_LINE = 2;
const TEST_LINE = 3;

/** A git-initialized monorepo with the SAME relative test file in two packages. */
function monorepo(): string {
  const top = tmp();
  gitInit(top);
  for (const pkg of ["a", "b"]) {
    const dir = path.join(top, "packages", pkg, "src");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "util.test.js"), SOURCE);
  }
  return top;
}

/** A validator backend whose only finding is package a's comment; records every invocation. */
function stubBackend(findingFile: string, marker: string): string {
  const dir = tmp();
  const file = path.join(dir, "validate-intent");
  const document = JSON.stringify({
    mode: "source",
    findings: [{ file: findingFile, line: COMMENT_LINE, kind: null, ok: true, errors: [], intent: INTENT }],
    summary: { annotations: 1 },
  });
  fs.writeFileSync(
    file,
    [
      "#!/bin/sh",
      "case \"$1\" in",
      `  --version) printf '%s\\n' 'validate-intent stub (test) schema sha256:${SCHEMA_CONTRACT_DIGEST}'; exit 0 ;;`,
      `  --schema-source) printf '%s\\n' 'schema <embedded schema> sha256:${SCHEMA_CONTRACT_DIGEST}'; exit 0 ;;`,
      "esac",
      "if [ \"$1\" = \"--source\" ]; then",
      `  echo "$@" >> '${marker}'`,
      `  printf '%s\\n' '${document.replace(/'/g, `'\\''`)}'`,
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
  return file;
}

async function inDir<T>(dir: string, fn: () => Promise<T>, backend?: string): Promise<T> {
  const before = process.cwd();
  const beforeBackend = process.env[VALIDATE_INTENT_ENV_VAR];
  const origWrite = process.stderr.write;
  process.chdir(dir);
  if (backend !== undefined) process.env[VALIDATE_INTENT_ENV_VAR] = backend;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return await fn();
  } finally {
    process.stderr.write = origWrite;
    process.chdir(before);
    if (beforeBackend === undefined) delete process.env[VALIDATE_INTENT_ENV_VAR];
    else process.env[VALIDATE_INTENT_ENV_VAR] = beforeBackend;
  }
}

function transport(seen: Envelope[]) {
  return {
    fetchImpl: (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)) as Envelope);
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch,
    appendFileImpl: async () => {},
  };
}

async function nodeTestRows(cwd: string, file: string, backend?: string): Promise<Envelope["specs"]> {
  const seen: Envelope[] = [];
  await inDir(
    cwd,
    async () => {
      const stream = specguardReporter(
        (async function* () {
          yield { type: "test:start", data: { name: "formats", nesting: 0 } };
          yield { type: "test:pass", data: { name: "formats", nesting: 0, file, line: TEST_LINE } };
        })(),
        { env: env(), transport: transport(seen) },
      );
      for await (const _ of stream) void _;
    },
    backend,
  );
  assert.equal(seen.length, 1);
  return seen[0]!.specs;
}

test("resolveRunRoots: an explicit repoRoot wins and serves both roots", () => {
  assert.deepEqual(resolveRunRoots("/some/root", "/elsewhere"), {
    pathRoot: "/some/root",
    walkRoot: "/some/root",
  });
});

test("resolveRunRoots: from a subdirectory the path root is the git toplevel, the walk root stays the cwd", () => {
  const top = monorepo();
  const sub = path.join(top, "packages", "a");
  assert.deepEqual(resolveRunRoots(undefined, sub), { pathRoot: top, walkRoot: sub });
});

test("resolveRunRoots: at the repo root both roots are the cwd (identical to cwd-relative behavior)", () => {
  const top = monorepo();
  assert.deepEqual(resolveRunRoots(undefined, top), { pathRoot: top, walkRoot: top });
});

test("resolveRunRoots: outside any git repository the path root falls back to the cwd", () => {
  const dir = tmp();
  assert.deepEqual(resolveRunRoots(undefined, dir), { pathRoot: dir, walkRoot: dir });
});

test("resolveRunRoots: a nested repository as cwd resolves to its OWN toplevel", () => {
  const top = monorepo();
  const inner = path.join(top, "packages", "inner");
  fs.mkdirSync(inner, { recursive: true });
  gitInit(inner);
  assert.deepEqual(resolveRunRoots(undefined, inner), { pathRoot: inner, walkRoot: inner });
});

test("node:test: packages a and b ship DISTINCT file_paths for the same package-relative test file", async () => {
  const top = monorepo();
  const rowsA = await nodeTestRows(
    path.join(top, "packages", "a"),
    path.join(top, "packages", "a", "src", "util.test.js"),
  );
  const rowsB = await nodeTestRows(
    path.join(top, "packages", "b"),
    path.join(top, "packages", "b", "src", "util.test.js"),
  );
  assert.equal(rowsA[0]!.file_path, "packages/a/src/util.test.js");
  assert.equal(rowsB[0]!.file_path, "packages/b/src/util.test.js");
  assert.notEqual(rowsA[0]!.id, rowsB[0]!.id);
});

test("node:test: a row stays `annotated` when the run starts in a subdirectory, and the walk stays in that subtree", async () => {
  const top = monorepo();
  const marker = path.join(tmp(), "invocations");
  const fileA = path.join(top, "packages", "a", "src", "util.test.js");
  const backend = stubBackend(fileA, marker);
  const rows = await nodeTestRows(path.join(top, "packages", "a"), fileA, backend);
  assert.equal(rows[0]!.file_path, "packages/a/src/util.test.js");
  assert.equal(rows[0]!.status, "annotated");
  assert.deepEqual(rows[0]!.intent, INTENT);

  // The walk is scoped to packages/a: the backend was handed a's file only.
  const args = fs.readFileSync(marker, "utf8");
  assert.ok(args.includes(fileA), args);
  assert.ok(!args.includes(path.join("packages", "b")), args);
});

test("node:test: outside git, rows are cwd-relative exactly as before", async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "src"));
  const rows = await nodeTestRows(dir, path.join(dir, "src", "util.test.js"));
  assert.equal(rows[0]!.file_path, "src/util.test.js");
});

test("Vitest: packages a and b ship distinct file_paths", async () => {
  const top = monorepo();
  const out: string[] = [];
  for (const pkg of ["a", "b"]) {
    const seen: Envelope[] = [];
    await inDir(path.join(top, "packages", pkg), async () => {
      const reporter = new SpecguardVitestReporter({ env: env(), transport: transport(seen) });
      await reporter.onTestRunEnd([
        {
          type: "module",
          moduleId: path.join(top, "packages", pkg, "src", "util.test.js"),
          children: {
            allTests: () =>
              [
                {
                  type: "test",
                  name: "formats",
                  fullName: "formats",
                  location: { line: TEST_LINE, column: 1 },
                  result: () => ({ state: "passed" }),
                  diagnostic: () => ({ duration: 5 }),
                },
              ][Symbol.iterator](),
          },
        } as never,
      ]);
    });
    out.push(seen[0]!.specs[0]!.file_path);
  }
  assert.deepEqual(out, ["packages/a/src/util.test.js", "packages/b/src/util.test.js"]);
});

test("Jest: packages a and b ship distinct file_paths", async () => {
  const top = monorepo();
  const out: string[] = [];
  for (const pkg of ["a", "b"]) {
    const seen: Envelope[] = [];
    await inDir(path.join(top, "packages", pkg), async () => {
      const reporter = new SpecguardJestReporter(
        {},
        { env: env(), transport: transport(seen) },
        { startRun: undefined, firstRun: true, previousSuccess: undefined },
      );
      await reporter.onRunComplete(new Map(), {
        testResults: [
          {
            testFilePath: path.join(top, "packages", pkg, "src", "util.test.js"),
            testResults: [
              {
                title: "formats",
                ancestorTitles: [],
                fullName: "formats",
                location: { line: TEST_LINE, column: 1 },
                status: "passed",
                duration: 5,
              },
            ],
          },
        ],
      });
    });
    out.push(seen[0]!.specs[0]!.file_path);
  }
  assert.deepEqual(out, ["packages/a/src/util.test.js", "packages/b/src/util.test.js"]);
});
