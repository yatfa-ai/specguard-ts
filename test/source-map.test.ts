import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { SourceMapResolver } from "../src/node-test/source-map.js";
import { RunCollector } from "../src/node-test/collector.js";

// A hand-made map: generated line 2 col 0 → source line 8 (0-based 7) col 0.
// Mappings are VLQ: line 0 empty, line 1 = segment [0,0,7,0] = "AAOA".
const MAPPINGS = ";AAOA";

interface Project {
  root: string;
  write: (rel: string, body: string) => string;
}

function project(): Project {
  const root = fs.mkdtempSync(join(os.tmpdir(), "specguard-sm-"));
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

function mapJson(sources: string[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 3, file: "a.test.js", sources, names: [], mappings: MAPPINGS, ...extra });
}

const LINES = "// header\ntest();\n";
const TRAILER = "//# sourceMappingURL=a.test.js.map\n";

test("a sibling map resolves a compiled position to the source path and 1-based line", () => {
  const p = project();
  const compiled = p.write("dist/a.test.js", LINES + TRAILER);
  const source = p.write("src/a.test.ts", "x\n");
  p.write("dist/a.test.js.map", mapJson(["../src/a.test.ts"]));
  assert.deepEqual(new SourceMapResolver(p.root).resolve(compiled, 2, 1), { file: source, line: 8 });
});

test("an inline data: URL map (base64 and percent-encoded) resolves the same way", () => {
  const p = project();
  const source = p.write("src/a.test.ts", "x\n");
  const json = mapJson(["../src/a.test.ts"]);
  const b64 = p.write(
    "dist/b64.test.js",
    `${LINES}//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(json).toString("base64")}\n`,
  );
  const plain = p.write(
    "dist/plain.test.js",
    `${LINES}//# sourceMappingURL=data:application/json,${encodeURIComponent(json)}\n`,
  );
  const r = new SourceMapResolver(p.root);
  assert.deepEqual(r.resolve(b64, 2, 1), { file: source, line: 8 });
  assert.deepEqual(r.resolve(plain, 2, 1), { file: source, line: 8 });
});

test("sourceRoot is applied to the map's sources", () => {
  const p = project();
  const compiled = p.write("dist/a.test.js", LINES + TRAILER);
  const source = p.write("src/a.test.ts", "x\n");
  p.write("dist/a.test.js.map", mapJson(["a.test.ts"], { sourceRoot: "../src/" }));
  assert.deepEqual(new SourceMapResolver(p.root).resolve(compiled, 2, 1), { file: source, line: 8 });
});

test("every failure keeps today's coordinates: resolve answers null, never throws", () => {
  const p = project();
  // no trailer
  const bare = p.write("dist/bare.test.js", LINES);
  // trailer, no map on disk
  const missing = p.write("dist/missing.test.js", `${LINES}//# sourceMappingURL=missing.test.js.map\n`);
  // corrupt map
  const corrupt = p.write("dist/corrupt.test.js", `${LINES}//# sourceMappingURL=corrupt.test.js.map\n`);
  p.write("dist/corrupt.test.js.map", "{not json");
  // map whose source does not exist
  const ghost = p.write("dist/ghost.test.js", `${LINES}//# sourceMappingURL=ghost.test.js.map\n`);
  p.write("dist/ghost.test.js.map", mapJson(["../src/ghost.test.ts"]));
  // source outside the repo root
  const outside = fs.mkdtempSync(join(os.tmpdir(), "specguard-sm-outside-"));
  fs.writeFileSync(join(outside, "o.test.ts"), "x\n");
  const escaping = p.write("dist/escape.test.js", `${LINES}//# sourceMappingURL=escape.test.js.map\n`);
  p.write("dist/escape.test.js.map", mapJson([join(outside, "o.test.ts")]));
  // source under node_modules
  p.write("node_modules/pkg/x.ts", "x\n");
  const vendored = p.write("dist/vendored.test.js", `${LINES}//# sourceMappingURL=vendored.test.js.map\n`);
  p.write("dist/vendored.test.js.map", mapJson(["../node_modules/pkg/x.ts"]));
  // remote source / remote map URL
  const remote = p.write("dist/remote.test.js", `${LINES}//# sourceMappingURL=remote.test.js.map\n`);
  p.write("dist/remote.test.js.map", mapJson(["webpack://app/src/a.test.ts"]));
  const remoteUrl = p.write("dist/remoteurl.test.js", `${LINES}//# sourceMappingURL=https://example.com/x.map\n`);
  // a map with no entry for the position
  const noEntry = p.write("dist/none.test.js", `${LINES}//# sourceMappingURL=none.test.js.map\n`);
  p.write("src/none.test.ts", "x\n");
  p.write("dist/none.test.js.map", JSON.stringify({ version: 3, sources: ["../src/none.test.ts"], names: [], mappings: "" }));
  // not compiled output: a .ts path the runner already source-mapped
  const ts = p.write("src/already.test.ts", "x\n");

  const r = new SourceMapResolver(p.root);
  for (const file of [bare, missing, corrupt, ghost, escaping, vendored, remote, remoteUrl, noEntry, ts]) {
    assert.equal(r.resolve(file, 2, 1), null, file);
    // A map with a valid single source but no entry still names its file.
    if (file !== noEntry) assert.equal(r.resolveFile(file), null, file);
  }
  assert.equal(r.resolve(join(p.root, "dist", "nonexistent.js"), 2, 1), null);
});

test("resolveFile names the single source a map was compiled from", () => {
  const p = project();
  const compiled = p.write("dist/a.test.js", LINES + TRAILER);
  const source = p.write("src/a.test.ts", "x\n");
  p.write("dist/a.test.js.map", mapJson(["../src/a.test.ts"]));
  assert.equal(new SourceMapResolver(p.root).resolveFile(compiled), source);
});

test("the collector ships a compiled row under its source path and line, and keeps unmappable rows as reported", () => {
  const p = project();
  const compiled = p.write("dist/a.test.js", LINES + TRAILER);
  p.write("src/a.test.ts", "x\n");
  p.write("dist/a.test.js.map", mapJson(["../src/a.test.ts"]));
  const plain = p.write("dist/plain.test.js", LINES);

  const c = new RunCollector(p.root);
  c.onStart({ name: "mapped", nesting: 0 });
  c.onResult({ name: "mapped", nesting: 0, file: compiled, line: 2, column: 1 }, "pass");
  c.onStart({ name: "unmapped", nesting: 0 });
  c.onResult({ name: "unmapped", nesting: 0, file: plain, line: 2, column: 1 }, "pass");
  const [mapped, unmapped] = c.getRows();
  assert.equal(mapped!.file_path, "src/a.test.ts");
  assert.equal(mapped!.line_number, 8);
  assert.equal(unmapped!.file_path, "dist/plain.test.js");
  assert.equal(unmapped!.line_number, 2);
});

test("a crashed compiled file is named by its source, and not double-counted with its failed test", () => {
  const p = project();
  const compiled = p.write("dist/a.test.js", LINES + TRAILER);
  p.write("src/a.test.ts", "x\n");
  p.write("dist/a.test.js.map", mapJson(["../src/a.test.ts"]));

  const crashOnly = new RunCollector(p.root);
  crashOnly.onStart({ name: compiled, nesting: 0 });
  crashOnly.onResult({ name: compiled, nesting: 0, file: compiled, line: 1, column: 1 }, "fail");
  const rows = crashOnly.getRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.file_path, "src/a.test.ts");
  assert.equal(rows[0]!.line_number, 1);

  const both = new RunCollector(p.root);
  both.onStart({ name: "t", nesting: 0 });
  both.onResult({ name: "t", nesting: 0, file: compiled, line: 2, column: 1 }, "fail");
  both.onStart({ name: compiled, nesting: 0 });
  both.onResult({ name: compiled, nesting: 0, file: compiled, line: 1, column: 1 }, "fail");
  assert.equal(both.getRows().length, 1, "the file already shipped a failed row of its own");
});
