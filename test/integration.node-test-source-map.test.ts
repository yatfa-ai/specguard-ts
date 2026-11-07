import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import type { Envelope } from "../src/core/types.js";
import { SCHEMA_CONTRACT_DIGEST } from "../src/core/validator.js";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..", "..");
const reporterPath = join(pkgRoot, "dist", "node-test", "reporter.js");
const tscPath = join(pkgRoot, "node_modules", "typescript", "lib", "tsc.js");

/**
 * The compiled-TypeScript flow: a real tsc-compiled project (`sourceMap: true`),
 * run with `node --test dist/` and the BUILT reporter, with and without
 * `--enable-source-maps`. The validate-intent backend is a stub that ratifies
 * the annotations in `src/cart.test.ts` (the lint walk fences `dist`, so
 * findings are always keyed at the TypeScript source).
 */
const CART_SOURCE = [
  'import { test, describe } from "node:test";',
  'import assert from "node:assert/strict";',
  "",
  "const discount: number = 10;",
  "",
  'describe("cart", () => {',
  '  // @intent: {"entity":"Cart","action":"apply promo code","behavior":"applies the discount"}',
  '  test("applies a promo code", () => {',
  "    assert.equal(discount, 10);",
  "  });",
  "",
  '  test("has no annotation", () => {});',
  "});",
  "",
].join("\n");

const CRASH_SOURCE = [
  'import { test } from "node:test";',
  "const code: number = 2;",
  'throw new Error("boom " + code);',
  'test("never runs", () => {});',
  "",
].join("\n");

const INTENT = { entity: "Cart", action: "apply promo code", behavior: "applies the discount" };

interface Project {
  root: string;
  cleanup: () => void;
}

function compiledProject(opts: { inline?: boolean } = {}): Project {
  const root = mkdtempSync(join(tmpdir(), "specguard-ts-sm-"));
  mkdirSync(join(root, "src"));
  symlinkSync(join(pkgRoot, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(root, "src", "cart.test.ts"), CART_SOURCE);
  writeFileSync(join(root, "src", "crash.test.ts"), CRASH_SOURCE);
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        outDir: "dist",
        rootDir: "src",
        types: ["node"],
        strict: true,
        ...(opts.inline === true ? { inlineSourceMap: true } : { sourceMap: true }),
      },
      include: ["src"],
    }),
  );
  execFileSync(process.execPath, [tscPath, "-p", root], { stdio: "pipe" });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function stubBackend(dir: string): string {
  const doc = JSON.stringify({
    mode: "source",
    findings: [
      {
        file: "src/cart.test.ts",
        line: 7,
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

/** `node --test dist/` in `project`, optionally with `--enable-source-maps`. */
async function run(project: Project, flags: string[] = []): Promise<Run> {
  const srv = await captureServer();
  const backendDir = mkdtempSync(join(tmpdir(), "specguard-ts-sm-validator-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SPECGUARD_ENDPOINT: srv.url,
    SPECGUARD_API_KEY: "sgk_integration",
    SPECGUARD_COMMIT_SHA: "deadbeef",
    SPECGUARD_RUN_ID: "17442",
    SPECGUARD_SHARD_ID: "0",
    SPECGUARD_TIMEOUT: "10",
    SPECGUARD_VALIDATE_INTENT: stubBackend(backendDir),
  };
  delete env.NODE_TEST_CONTEXT;
  let code = 0;
  let stderr = "";
  try {
    const out = await execFileAsync(
      process.execPath,
      ["--test", ...flags, `--test-reporter=${reporterPath}`, "dist/"],
      { cwd: project.root, env },
    );
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

test("compiled TypeScript WITHOUT --enable-source-maps ships the .ts source, source lines, and the annotation", async () => {
  const project = compiledProject();
  try {
    const { specs } = await run(project);
    const byName = new Map(specs.map((s) => [s.name, s]));
    const applies = byName.get("cart > applies a promo code")!;
    assert.equal(applies.file_path, "src/cart.test.ts");
    assert.equal(applies.line_number, 8);
    assert.equal(applies.status, "annotated");
    assert.deepEqual(applies.intent, INTENT);
    const bare = byName.get("cart > has no annotation")!;
    assert.equal(bare.file_path, "src/cart.test.ts");
    assert.equal(bare.line_number, 12);
    assert.equal(bare.status, "unannotated");
    assert.ok(!specs.some((s) => s.file_path.startsWith("dist/") && s.name.startsWith("cart")));
  } finally {
    project.cleanup();
  }
});

test("rows are identical, ids included, with and without --enable-source-maps", async () => {
  const project = compiledProject();
  try {
    const without = await run(project);
    const withFlag = await run(project, ["--enable-source-maps"]);
    assert.ok(without.specs.length >= 3, JSON.stringify(without.specs.map((s) => s.name)));
    assert.deepEqual(stable(without.specs), stable(withFlag.specs));
    assert.equal(without.code, withFlag.code);
  } finally {
    project.cleanup();
  }
});

test("an inline (data: URL) source map maps the same way", async () => {
  const project = compiledProject({ inline: true });
  try {
    const { specs } = await run(project);
    const applies = specs.find((s) => s.name === "cart > applies a promo code")!;
    assert.equal(applies.file_path, "src/cart.test.ts");
    assert.equal(applies.line_number, 8);
    assert.equal(applies.status, "annotated");
  } finally {
    project.cleanup();
  }
});

test("a compiled file that crashed is named by its source, matching the --enable-source-maps run", async () => {
  const project = compiledProject();
  try {
    const without = await run(project);
    const crash = without.specs.find((s) => s.name.includes("(test file failed to run)"))!;
    assert.equal(crash.file_path, "src/crash.test.ts");
    assert.equal(without.code, 1);
    const withFlag = await run(project, ["--enable-source-maps"]);
    assert.deepEqual(stable(without.specs), stable(withFlag.specs));
  } finally {
    project.cleanup();
  }
});

/** The compiled-coordinate baseline: a run of the same project with every map removed. */
async function baseline(): Promise<Run> {
  const project = compiledProject();
  try {
    for (const name of ["cart", "crash"]) rmSync(join(project.root, "dist", `${name}.test.js.map`));
    return await run(project);
  } finally {
    project.cleanup();
  }
}

for (const [label, sabotage] of [
  ["missing", (dist: string) => rmSync(join(dist, "cart.test.js.map"))],
  ["corrupt", (dist: string) => writeFileSync(join(dist, "cart.test.js.map"), "{not json")],
  [
    "pointing outside the repo",
    (dist: string) => {
      const mapFile = join(dist, "cart.test.js.map");
      const outside = join(mkdtempSync(join(tmpdir(), "specguard-ts-sm-outside-")), "elsewhere.ts");
      writeFileSync(outside, "x\n");
      const map = JSON.parse(readFileSync(mapFile, "utf8")) as { sources: string[] };
      map.sources = [outside];
      writeFileSync(mapFile, JSON.stringify(map));
    },
  ],
] as const) {
  test(`a compiled file whose map is ${label} ships today's compiled rows, exit code and stderr`, async () => {
    const reference = await baseline();
    const project = compiledProject();
    try {
      sabotage(join(project.root, "dist"));
      const sabotaged = await run(project);
      const cart = (rows: Envelope["specs"]) => rows.filter((s) => s.name.startsWith("cart"));
      assert.ok(cart(sabotaged.specs).length === 2);
      for (const spec of cart(sabotaged.specs)) {
        assert.equal(spec.file_path, "dist/cart.test.js");
        assert.equal(spec.status, "unannotated");
      }
      assert.deepEqual(
        stable(cart(sabotaged.specs)),
        stable(cart(reference.specs)),
        "same rows as a run where no map exists at all",
      );
      assert.equal(sabotaged.code, reference.code);
      assert.equal(sabotaged.stderr, reference.stderr);
    } finally {
      project.cleanup();
    }
  });
}
