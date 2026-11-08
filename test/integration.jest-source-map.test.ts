import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import type { Envelope } from "../src/core/types.js";
import { SCHEMA_CONTRACT_DIGEST } from "../src/core/validator.js";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..", "..");
const reporterPath = join(pkgRoot, "dist", "jest", "reporter.js");
const tscPath = join(pkgRoot, "node_modules", "typescript", "lib", "tsc.js");

/**
 * The compiled-TypeScript Jest flow (`tsc && jest dist/`): a real tsc-compiled
 * project (`sourceMap: true`), run by a real `jest` child with the BUILT
 * reporter, under both `testLocationInResults` settings. Jest is an OPTIONAL
 * peer, so these self-skip when it is not installed (see
 * integration.jest.test.ts). The validate-intent backend is a stub that
 * ratifies the annotation in `src/cart.test.ts` (findings are keyed at the
 * TypeScript source).
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

const GLOBALS = [
  "export {};",
  "declare const describe: (name: string, fn: () => void) => void;",
  "declare const it: (name: string, fn: () => void) => void;",
  "declare const expect: (v: unknown) => { toBe: (x: unknown) => void };",
].join("\n");

const CART_SOURCE = [
  GLOBALS,
  "",
  "const discount: number = 10;",
  "",
  'describe("cart", () => {',
  '  // @intent: {"entity":"Cart","action":"apply promo code","behavior":"applies the discount"}',
  '  it("applies a promo code", () => {',
  "    expect(discount).toBe(10);",
  "  });",
  "",
  '  it("has no annotation", () => {});',
  "});",
  "",
].join("\n");

const CRASH_SOURCE = [
  GLOBALS,
  "const code: number = 2;",
  'throw new Error("boom " + code);',
  "",
].join("\n");

const INTENT = { entity: "Cart", action: "apply promo code", behavior: "applies the discount" };
const ANNOTATION_LINE = CART_SOURCE.split("\n").findIndex((l) => l.includes("// @intent:")) + 1;
const APPLIES_LINE = ANNOTATION_LINE + 1;
const BARE_LINE = CART_SOURCE.split("\n").findIndex((l) => l.includes('it("has no annotation"')) + 1;

interface Project {
  root: string;
  cleanup: () => void;
}

function compiledProject(opts: { sources?: Record<string, string> } = {}): Project {
  const root = mkdtempSync(join(tmpdir(), "specguard-ts-jest-sm-"));
  mkdirSync(join(root, "src"));
  symlinkSync(join(pkgRoot, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), "{}\n");
  const sources = opts.sources ?? { "cart.test.ts": CART_SOURCE, "crash.test.ts": CRASH_SOURCE };
  for (const [name, body] of Object.entries(sources)) writeFileSync(join(root, "src", name), body);
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "commonjs",
        outDir: "dist",
        rootDir: "src",
        types: [],
        strict: true,
        sourceMap: true,
      },
      include: ["src"],
    }),
  );
  execFileSync(process.execPath, [tscPath, "-p", root], { stdio: "pipe" });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeConfig(project: Project, locationInResults: boolean, testMatch: string[]): string {
  const config = join(project.root, "jest.config.cjs");
  writeFileSync(
    config,
    [
      "module.exports = {",
      `  rootDir: ${JSON.stringify(project.root)},`,
      `  testMatch: ${JSON.stringify(testMatch)},`,
      "  transform: {},",
      `  reporters: ["default", ${JSON.stringify(reporterPath)}],`,
      `  testLocationInResults: ${String(locationInResults)},`,
      "};",
      "",
    ].join("\n"),
  );
  return config;
}

function stubBackend(dir: string): string {
  const doc = JSON.stringify({
    mode: "source",
    findings: [
      {
        file: "src/cart.test.ts",
        line: ANNOTATION_LINE,
        kind: null,
        ok: true,
        errors: [],
        intent: INTENT,
      },
    ],
    summary: { annotations: 1 },
  });
  const file = join(dir, "validate-intent");
  writeFileSync(
    file,
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
  return file;
}

async function captureServer(): Promise<{
  captured: Envelope[];
  url: string;
  close: () => Promise<void>;
}> {
  const captured: Envelope[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const text =
        req.headers["content-encoding"] === "gzip"
          ? gunzipSync(raw).toString("utf8")
          : raw.toString("utf8");
      captured.push(JSON.parse(text) as Envelope);
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


interface Run {
  code: number;
  stderr: string;
  specs: Envelope["specs"];
}

async function runJest(project: Project, locationInResults: boolean): Promise<Run> {
  if (jestBin === null) throw new Error("jest not installed");
  const srv = await captureServer();
  const backendDir = mkdtempSync(join(tmpdir(), "specguard-ts-jest-sm-validator-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SPECGUARD_ENDPOINT: srv.url,
    SPECGUARD_API_KEY: "sgk_integration",
    SPECGUARD_COMMIT_SHA: "deadbeef",
    SPECGUARD_RUN_ID: "17442",
    SPECGUARD_SHARD_ID: "0",
    SPECGUARD_TIMEOUT: "10",
    SPECGUARD_VALIDATE_INTENT: stubBackend(backendDir),
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
  delete env.NODE_TEST_CONTEXT;
  const config = writeConfig(project, locationInResults, ["<rootDir>/dist/**/*.test.js"]);
  let code = 0;
  let stderr = "";
  try {
    const out = await execFileAsync(process.execPath, [jestBin, "--config", config, "--runInBand"], {
      cwd: project.root,
      env,
      timeout: 120_000,
    });
    stderr = out.stderr;
  } catch (err) {
    const e = err as { code?: number; stderr?: string };
    code = e.code ?? -1;
    stderr = e.stderr ?? "";
  } finally {
    await srv.close();
    rmSync(backendDir, { recursive: true, force: true });
  }
  return { code, stderr, specs: srv.captured[0]?.specs ?? [] };
}

/** A row without its wall-clock `duration`, which legitimately differs run to run. */
function stable(specs: Envelope["specs"]): unknown[] {
  return specs
    .map(({ duration: _duration, ...rest }) => rest)
    .sort((a, b) => a.id.localeCompare(b.id));
}

for (const locationInResults of [true, false]) {
  const flag = `testLocationInResults: ${String(locationInResults)}`;

  test(`compiled TypeScript (${flag}) ships the .ts source path, the TypeScript lines, and the annotation`, async (t) => {
    if (jestBin === null) return t.skip("jest not installed — adapter e2e skipped (optional peer)");
    const project = compiledProject();
    try {
      const { specs } = await runJest(project, locationInResults);
      const byName = new Map(specs.map((s) => [s.name, s]));
      const applies = byName.get("cart > applies a promo code")!;
      assert.equal(applies.file_path, "src/cart.test.ts");
      assert.equal(applies.line_number, APPLIES_LINE);
      assert.equal(applies.status, "annotated");
      assert.deepEqual(applies.intent, INTENT);
      const bare = byName.get("cart > has no annotation")!;
      assert.equal(bare.file_path, "src/cart.test.ts");
      assert.equal(bare.line_number, BARE_LINE);
      assert.equal(bare.status, "unannotated");
      assert.ok(!specs.some((s) => s.file_path.startsWith("dist/")));
    } finally {
      project.cleanup();
    }
  });

  test(`a compiled suite that crashed is named by its source (${flag})`, async (t) => {
    if (jestBin === null) return t.skip("jest not installed — adapter e2e skipped (optional peer)");
    const project = compiledProject();
    try {
      const { specs, code } = await runJest(project, locationInResults);
      const crash = specs.find((s) => s.name.includes("(test file failed to run)"))!;
      assert.equal(crash.file_path, "src/crash.test.ts");
      assert.equal(crash.line_number, 1);
      assert.equal(crash.outcome, "failed");
      assert.equal(code, 1);
    } finally {
      project.cleanup();
    }
  });

  /** The compiled-coordinate baseline: the same project with every map removed. */
  const baseline = async (): Promise<Run> => {
    const project = compiledProject();
    try {
      for (const name of ["cart", "crash"]) rmSync(join(project.root, "dist", `${name}.test.js.map`));
      return await runJest(project, locationInResults);
    } finally {
      project.cleanup();
    }
  };

  // A map the RESOLVER must refuse is not always a map JEST refuses: with
  // `testLocationInResults` Jest applies a present-but-foreign map to its own
  // reported lines, so rows cannot be expected to equal a map-deleted run.
  // What every refusal must hold is the resolver's own contract: the row
  // keeps the COMPILED path (never the refused source) and the annotation
  // never attributes; a map Jest cannot use either (missing, corrupt) leaves
  // the whole run byte-equal to a run with no map at all.
  for (const [label, sabotage, equalsNoMapRun] of [
    ["missing", (dist: string) => rmSync(join(dist, "cart.test.js.map")), true],
    ["corrupt", (dist: string) => writeFileSync(join(dist, "cart.test.js.map"), "{not json"), true],
    [
      "pointing outside the repo",
      (dist: string) => {
        const mapFile = join(dist, "cart.test.js.map");
        const outside = join(mkdtempSync(join(tmpdir(), "specguard-ts-jest-sm-outside-")), "elsewhere.ts");
        writeFileSync(outside, "x\n");
        const map = JSON.parse(readFileSync(mapFile, "utf8")) as { sources: string[] };
        map.sources = [outside];
        writeFileSync(mapFile, JSON.stringify(map));
      },
      false,
    ],
    [
      "naming a source under node_modules",
      (dist: string) => {
        const mapFile = join(dist, "cart.test.js.map");
        const root = join(dist, "..");
        mkdirSync(join(root, "vendor", "node_modules"), { recursive: true });
        writeFileSync(join(root, "vendor", "node_modules", "x.ts"), "x\n");
        const map = JSON.parse(readFileSync(mapFile, "utf8")) as { sources: string[] };
        map.sources = ["../vendor/node_modules/x.ts"];
        writeFileSync(mapFile, JSON.stringify(map));
      },
      false,
    ],
  ] as const) {
    test(`a compiled suite whose map is ${label} ships the compiled path, never the refused source (${flag})`, async (t) => {
      if (jestBin === null) return t.skip("jest not installed — adapter e2e skipped (optional peer)");
      const reference = await baseline();
      const project = compiledProject();
      try {
        // The crash suite's map is not under test — remove it everywhere so
        // the default reporter's code frame for the crash is identical in
        // both runs (with its map Jest frames the .ts source; without it,
        // the compiled file).
        rmSync(join(project.root, "dist", "crash.test.js.map"), { force: true });
        sabotage(join(project.root, "dist"));
        const sabotaged = await runJest(project, locationInResults);
        const cart = (rows: Envelope["specs"]) => rows.filter((s) => s.name.startsWith("cart"));
        assert.equal(cart(sabotaged.specs).length, 2);
        for (const spec of cart(sabotaged.specs)) {
          assert.equal(spec.file_path, "dist/cart.test.js");
          assert.equal(spec.status, "unannotated");
        }
        assert.ok(
          !sabotaged.specs.some((s) => s.file_path.includes("elsewhere") || s.file_path.includes("node_modules")),
        );
        if (equalsNoMapRun) {
          assert.deepEqual(
            stable(cart(sabotaged.specs)),
            stable(cart(reference.specs)),
            "same rows as a run where no map exists at all",
          );
        }
        assert.equal(sabotaged.code, reference.code);
        // stderr matches modulo Jest's wall-clock `Time:` line and Jest's own
        // "Failed to parse the source map" notice, which a corrupt map makes
        // JEST print (its own pipeline, not this reporter's).
        const withoutJestNoise = (stderr: string) =>
          stderr
            .split("\n")
            .filter((l) => !l.startsWith("Time:") && !l.startsWith("Failed to parse the source map"))
            .join("\n");
        assert.equal(withoutJestNoise(sabotaged.stderr), withoutJestNoise(reference.stderr));
      } finally {
        project.cleanup();
      }
    });
  }
}

test("the two testLocationInResults settings ship identical rows (lines not double-mapped)", async (t) => {
  if (jestBin === null) return t.skip("jest not installed — adapter e2e skipped (optional peer)");
  const project = compiledProject();
  try {
    const on = await runJest(project, true);
    const off = await runJest(project, false);
    assert.ok(on.specs.length >= 3, JSON.stringify(on.specs.map((s) => s.name)));
    assert.deepEqual(stable(on.specs), stable(off.specs));
  } finally {
    project.cleanup();
  }
});
