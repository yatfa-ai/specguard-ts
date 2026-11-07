import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SourceMapResolver } from "../src/node-test/source-map.js";

// Member-level pins for SourceMapResolver arms the happy-path suite in
// source-map.test.ts leaves unexercised (each one was a mutation survivor).
// Same fixture style as that file: a throwaway project on disk and a hand-made
// map whose VLQ mappings are spelled out.

// Generated line 2 col 0 → source line 8 (0-based 7): ";AAOA".
const MAPPINGS = ";AAOA";

interface Project {
  root: string;
  write: (rel: string, body: string) => string;
}

function project(): Project {
  const root = fs.mkdtempSync(join(os.tmpdir(), "specguard-smm-"));
  return {
    root,
    write(rel, body) {
      const full = join(root, rel);
      fs.mkdirSync(join(full, ".."), { recursive: true });
      fs.writeFileSync(full, body);
      return full;
    },
  };
}

function mapJson(sources: string[], mappings: string = MAPPINGS): string {
  return JSON.stringify({ version: 3, file: "a.test.js", sources, names: [], mappings });
}

const LINES = "// header\ntest();\n";
const TRAILER = "//# sourceMappingURL=a.test.js.map\n";

test("compiled .mjs and .cjs output is mapped, not only .js", () => {
  const p = project();
  const source = p.write("src/a.test.ts", "x\n");
  const mjs = p.write("dist/a.test.mjs", `${LINES}//# sourceMappingURL=a.test.mjs.map\n`);
  p.write("dist/a.test.mjs.map", mapJson(["../src/a.test.ts"]));
  const cjs = p.write("dist/b.test.cjs", `${LINES}//# sourceMappingURL=b.test.cjs.map\n`);
  p.write("dist/b.test.cjs.map", mapJson(["../src/a.test.ts"]));
  const r = new SourceMapResolver(p.root);
  assert.deepEqual(r.resolve(mjs, 2, 1), { file: source, line: 8 });
  assert.deepEqual(r.resolve(cjs, 2, 1), { file: source, line: 8 });
  assert.equal(r.resolveFile(mjs), source);
  assert.equal(r.resolveFile(cjs), source);
});

test("the legacy `//@ sourceMappingURL=` trailer is honoured", () => {
  const p = project();
  const source = p.write("src/a.test.ts", "x\n");
  const compiled = p.write("dist/a.test.js", `${LINES}//@ sourceMappingURL=a.test.js.map\n`);
  p.write("dist/a.test.js.map", mapJson(["../src/a.test.ts"]));
  assert.deepEqual(new SourceMapResolver(p.root).resolve(compiled, 2, 1), { file: source, line: 8 });
});

test("the column picks among several segments on one generated line", () => {
  const p = project();
  const source = p.write("src/a.test.ts", "x\n");
  const compiled = p.write("dist/a.test.js", LINES + TRAILER);
  // Generated line 2 has two segments: col 0 → source line 8, col 5 → source line 10.
  p.write("dist/a.test.js.map", mapJson(["../src/a.test.ts"], ";AAOA,KAEA"));
  const r = new SourceMapResolver(p.root);
  // node:test columns are 1-based: column 5 is offset 4 (first segment),
  // column 6 is offset 5 (second segment).
  assert.deepEqual(r.resolve(compiled, 2, 5), { file: source, line: 8 });
  assert.deepEqual(r.resolve(compiled, 2, 6), { file: source, line: 10 });
});

test("a map whose sources are file:// URLs resolves to the path on disk", () => {
  const p = project();
  const source = p.write("src/a.test.ts", "x\n");
  const compiled = p.write("dist/a.test.js", LINES + TRAILER);
  p.write("dist/a.test.js.map", mapJson([pathToFileURL(source).href]));
  const r = new SourceMapResolver(p.root);
  assert.deepEqual(r.resolve(compiled, 2, 1), { file: source, line: 8 });
  assert.equal(r.resolveFile(compiled), source);
});

test("resolveFile on a map naming several sources answers the file's first mapping", () => {
  const p = project();
  const first = p.write("src/first.ts", "x\n");
  p.write("src/second.ts", "x\n");
  const compiled = p.write("dist/bundle.js", `${LINES}//# sourceMappingURL=bundle.js.map\n`);
  // One segment at generated (0,0) → sources[0].
  p.write("dist/bundle.js.map", mapJson(["../src/first.ts", "../src/second.ts"], "AAAA"));
  assert.equal(new SourceMapResolver(p.root).resolveFile(compiled), first);
});

test("a relative compiled path is resolved against baseDir, not the repo root", () => {
  const p = project();
  const source = p.write("src/a.test.ts", "x\n");
  p.write("pkg/dist/a.test.js", LINES + TRAILER);
  p.write("pkg/dist/a.test.js.map", mapJson(["../../src/a.test.ts"]));
  const r = new SourceMapResolver(p.root, join(p.root, "pkg"));
  assert.deepEqual(r.resolve("dist/a.test.js", 2, 1), { file: source, line: 8 });
  assert.equal(r.resolveFile("dist/a.test.js"), source);
});

test("a percent-encoded sibling map URL is decoded to the file name", () => {
  const p = project();
  const source = p.write("src/a.test.ts", "x\n");
  const compiled = p.write("dist/a.test.js", `${LINES}//# sourceMappingURL=my%20map.js.map\n`);
  p.write("dist/my map.js.map", mapJson(["../src/a.test.ts"]));
  assert.deepEqual(new SourceMapResolver(p.root).resolve(compiled, 2, 1), { file: source, line: 8 });
});

test("a `data:text/json` URL map is accepted like `data:application/json`", () => {
  const p = project();
  const source = p.write("src/a.test.ts", "x\n");
  const json = mapJson(["../src/a.test.ts"]);
  const compiled = p.write(
    "dist/a.test.js",
    `${LINES}//# sourceMappingURL=data:text/json,${encodeURIComponent(json)}\n`,
  );
  assert.deepEqual(new SourceMapResolver(p.root).resolve(compiled, 2, 1), { file: source, line: 8 });
});
