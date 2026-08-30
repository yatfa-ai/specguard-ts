import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { run } from "../src/core/ingest-cli.js";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Harness

/** Captures stdout/stderr as strings; structurally an IngestStream. */
function out(): { stream: { write(text: string): void }; text(): string } {
  let buffer = "";
  return {
    stream: { write: (text: string) => { buffer += text; } },
    text: () => buffer,
  };
}

/** One saved run line, hand-shaped so a re-stringify would CHANGE it (see the byte-for-byte test). */
function runLine(ciRunId: string, branch = "main"): string {
  return `{"commit_sha":"0d4a1f2c9b8e7d6a5f4c3b2a1908f7e6d5c4b3a2","branch":"${branch}","ci_run_id":"${ciRunId}","shard_id":"0","duration_seconds":1.50,"specs":[{"id":"id-1","file_path":"test/a.test.js","line_number":3,"name":"works","outcome":"passed","status":"unannotated","intent":null,"duration":0.01}]}`;
}

function tmpFile(name: string, contents: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "specguard-ingest-"));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

function rm(path: string): void {
  rmSync(dirname(path), { recursive: true, force: true });
}

function envFor(
  serverUrl: string | null,
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    SPECGUARD_COMMIT_SHA: "0d4a1f2c9b8e7d6a5f4c3b2a1908f7e6d5c4b3a2",
    SPECGUARD_TIMEOUT: "2",
  };
  if (serverUrl !== null) {
    env.SPECGUARD_ENDPOINT = serverUrl;
    env.SPECGUARD_API_KEY = "sgk_ingest_test";
  }
  return { ...env, ...overrides };
}

interface Delivered {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(
  argv: string[],
  serverUrl: string | null = null,
  overrides: Record<string, string | undefined> = {},
): Promise<Delivered> {
  const o = out();
  const e = out();
  const code = await run(argv, o.stream, e.stream, { env: envFor(serverUrl, overrides) });
  return { code, stdout: o.text(), stderr: e.text() };
}

interface Verdict {
  status: number;
  body: string;
}

interface Capture {
  bodies: string[];
  encodings: (string | undefined)[];
  url: string;
  respond: (status: number, body: string) => void;
  close: () => Promise<void>;
}

/**
 * A capture server that records every POSTed body verbatim (gunzipping when
 * the request claims gzip) and answers from a settable verdict — or a
 * per-request sequence, whose LAST entry keeps answering once consumed.
 */
async function captureServer(initial: Verdict, sequence?: Verdict[]): Promise<Capture> {
  const bodies: string[] = [];
  const encodings: (string | undefined)[] = [];
  let verdict = initial;
  let queue = sequence ?? null;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const bytes = Buffer.concat(chunks);
      encodings.push(req.headers["content-encoding"]);
      bodies.push(
        req.headers["content-encoding"] === "gzip"
          ? gunzipSync(bytes).toString("utf8")
          : bytes.toString("utf8"),
      );
      const answer =
        queue !== null
          ? queue.length > 1
            ? (queue.shift() as Verdict)
            : (queue[0] as Verdict)
          : verdict;
      res.statusCode = answer.status;
      res.end(answer.body);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    bodies,
    encodings,
    url: `http://127.0.0.1:${port}`,
    respond: (status, body) => {
      verdict = { status, body };
      queue = null;
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve(undefined));
        server.closeAllConnections();
      }),
  };
}

// ---------------------------------------------------------------------------
// Usage errors — every one is a 2 that names what was wrong

test("usage: no file, two files, and an unknown option are each a 2 naming the problem", async () => {
  const noFile = await runCli([]);
  assert.equal(noFile.code, 2);
  assert.match(noFile.stderr, /no file given — Usage: specguard-ingest/);

  const two = await runCli(["a.jsonl", "b.jsonl"]);
  assert.equal(two.code, 2);
  assert.match(two.stderr, /one file at a time, got 2: a\.jsonl, b\.jsonl/);

  const file = tmpFile("q.jsonl", `${runLine("17")}\n`);
  try {
    const bad = await runCli(["--dry-runn", file]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /invalid option: --dry-runn/);
  } finally {
    rm(file);
  }
});

test("usage: no endpoint and no API key are separate 2s naming the separate fixes", async () => {
  const file = tmpFile("q.jsonl", `${runLine("17")}\n`);
  try {
    const noEndpoint = await runCli([file]);
    assert.equal(noEndpoint.code, 2);
    assert.match(noEndpoint.stderr, /no endpoint is configured \(set SPECGUARD_ENDPOINT\)/);

    const noKey = await runCli([file], "http://127.0.0.1:1", { SPECGUARD_API_KEY: undefined });
    assert.equal(noKey.code, 2);
    assert.match(noKey.stderr, /no API key is configured \(set SPECGUARD_API_KEY\)/);
  } finally {
    rm(file);
  }
});

test("usage: a missing file and a directory are named differently, both 2s", async () => {
  const missing = await runCli(["/nonexistent/nope.jsonl"], "http://127.0.0.1:1");
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /error: no such file: \/nonexistent\/nope\.jsonl/);

  const dir = mkdtempSync(join(tmpdir(), "specguard-ingest-dir-"));
  try {
    const isDir = await runCli([dir], "http://127.0.0.1:1");
    assert.equal(isDir.code, 2);
    assert.match(isDir.stderr, /error: not a file: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// --list: the check-the-file-first instrument

test("--list needs no credentials: it rows the file, delivers nothing, exits 0", async () => {
  const file = tmpFile("q.jsonl",
    `${runLine("17442")}\n` +
    `${runLine("17442", "")}\n` + // branch "" — present but empty, reads as no branch
    `{"commit_sha":"abc123"}\n` +
    `not json at all\n`);
  try {
    // Deliberately no server at all: listing must not need one.
    const r = await runCli(["--list", file]);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, "");
    assert.match(r.stdout, /line 1: branch main, commit_sha 0d4a1f2c9b8e7d6a5f4c3b2a1908f7e6d5c4b3a2, ci_run_id 17442, 1 example, 1\.5s/);
    assert.match(r.stdout, /line 2: no branch, commit_sha 0d4a1f2c9b8e7d6a5f4c3b2a1908f7e6d5c4b3a2, ci_run_id 17442, 1 example, 1\.5s/);
    assert.match(r.stdout, /line 3: no branch, commit_sha abc123, no ci_run_id, no specs, no duration_seconds/);
    assert.match(r.stdout, /line 4: unparseable — could not parse the line as JSON/);
    assert.match(r.stdout, /specguard-ingest: listed 4 lines from /);
    assert.match(r.stdout, /nothing was delivered/);
  } finally {
    rm(file);
  }
});

test("--list: 0 examples is '0 examples', distinct from a line that does not say", async () => {
  const file = tmpFile("q.jsonl", `{"branch":"x","specs":[]}\n`);
  try {
    const r = await runCli(["--list", file]);
    assert.match(r.stdout, /line 1: branch x, no commit_sha, no ci_run_id, 0 examples, no duration_seconds/);
  } finally {
    rm(file);
  }
});

test("--list: a line that is not valid UTF-8 is a row, not a crash and not an exit code", async () => {
  // 0xff is never valid UTF-8; pointing the command at a binary file by
  // mistake is the obvious way to get one.
  const file = tmpFile("q.jsonl", Buffer.concat([
    Buffer.from(runLine("17"), "utf8"), Buffer.from([0x0a]),
    Buffer.from([0x22, 0xff, 0xfe, 0x22]), Buffer.from([0x0a]),
  ]));
  try {
    const r = await runCli(["--list", file]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /line 2: unparseable — the line is not valid UTF-8, so it cannot be a run/);
    assert.match(r.stdout, /listed 2 lines from /);
  } finally {
    rm(file);
  }
});

test("--list composes with --from-line and --lines, previewing exactly that set", async () => {
  const contents = [1, 2, 3, 4].map((i) => runLine(`run-${i}`)).join("\n") + "\n";
  const file = tmpFile("q.jsonl", contents);
  try {
    const from = await runCli(["--list", "--from-line", "3", file]);
    assert.equal(from.code, 0);
    assert.ok(!from.stdout.includes("run-1"));
    assert.ok(!from.stdout.includes("run-2"));
    assert.match(from.stdout, /line 3: /);
    assert.match(from.stdout, /line 4: /);
    assert.match(from.stdout, /2 earlier lines skipped by --from-line/);

    const set = await runCli(["--list", "--lines", "2,4", file]);
    assert.equal(set.code, 0);
    assert.ok(set.stdout.includes("run-2"));
    assert.ok(!set.stdout.includes("run-1"));
    assert.ok(!set.stdout.includes("run-3"));
    assert.match(set.stdout, /2 lines not selected by --lines/);
  } finally {
    rm(file);
  }
});

test("--list: an empty file is a loud 0, and the warning names what was held back when something was", async () => {
  const empty = tmpFile("e.jsonl", "");
  try {
    const r = await runCli(["--list", empty]);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /specguard-ingest: warning: .* holds no runs to list\n$/);
    assert.equal(r.stdout, "");

    const held = tmpFile("h.jsonl", `${runLine("1")}\n${runLine("2")}\n`);
    try {
      const r2 = await runCli(["--list", "--lines", "9", held]);
      assert.equal(r2.code, 0);
      assert.match(r2.stderr, /holds no runs to list \(2 lines not selected by --lines\)/);
    } finally {
      rm(held);
    }
  } finally {
    rm(empty);
  }
});

// ---------------------------------------------------------------------------
// Selectors

test("--from-line delivers a suffix and counts the prefix it held back, singular and plural", async () => {
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"tr_1"}' });
  try {
    const one = tmpFile("one.jsonl", `${runLine("1")}\n${runLine("2")}\n`);
    const r1 = await runCli(["--from-line", "2", one], srv.url);
    assert.equal(r1.code, 0);
    assert.ok(!r1.stdout.includes("ci_run_id 1,"));
    assert.match(r1.stdout, /delivered 1 of 1 run from /);
    assert.match(r1.stdout, /1 earlier line skipped by --from-line/);
    rm(one);

    const two = tmpFile(
      "two.jsonl",
      [1, 2, 3, 4].map((i) => runLine(String(i))).join("\n") + "\n",
    );
    const r2 = await runCli(["--from-line", "3", two], srv.url);
    assert.equal(r2.code, 0);
    assert.match(r2.stdout, /delivered 2 of 2 runs from /);
    assert.match(r2.stdout, /2 earlier lines skipped by --from-line/);
    assert.ok(!r2.stdout.includes("ci_run_id 1,"));
    assert.ok(!r2.stdout.includes("ci_run_id 2,"));
    rm(two);
  } finally {
    await srv.close();
  }
});

test("--lines delivers exactly the named set over the file's own numbering, ranges unexpanded", async () => {
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"tr_1"}' });
  try {
    const contents = [1, 2, 3, 4, 5, 6].map((i) => runLine(`run-${i}`)).join("\n") + "\n";
    const file = tmpFile("q.jsonl", contents);
    const r = await runCli(["--lines", "2,4-5", file], srv.url);
    assert.equal(r.code, 0);
    // Delivered in file order, only lines 2, 4, 5.
    assert.deepEqual(srv.bodies.map((b) => /run-(\d)/.exec(b)?.[1]), ["2", "4", "5"]);
    assert.match(r.stdout, /delivered 3 of 3 runs from /);
    assert.match(r.stdout, /3 lines not selected by --lines/);
    rm(file);
  } finally {
    await srv.close();
  }
});

test("a repeated selector is last-wins, never an error — one flag answering its own question twice", async () => {
  const contents = [1, 2, 3, 4].map((i) => runLine(`run-${i}`)).join("\n") + "\n";
  const file = tmpFile("q.jsonl", contents);
  try {
    const lines = await runCli(["--list", "--lines", "1,2", "--lines", "4", file]);
    assert.equal(lines.code, 0);
    assert.ok(!lines.stdout.includes("run-1"));
    assert.ok(!lines.stdout.includes("run-2"));
    assert.ok(lines.stdout.includes("run-4"));

    const from = await runCli(["--list", "--from-line", "2", "--from-line", "3", file]);
    assert.equal(from.code, 0);
    assert.ok(!from.stdout.includes("run-1"));
    assert.ok(!from.stdout.includes("run-2"));
    assert.ok(from.stdout.includes("run-3"));
  } finally {
    rm(file);
  }
});

test("--from-line and --lines together are refused with a 2 — an intersection would silently drop a typed number", async () => {
  const file = tmpFile("q.jsonl", `${runLine("1")}\n`);
  try {
    const r = await runCli(["--from-line", "5", "--lines", "3,7", file]);
    assert.equal(r.code, 2);
    assert.match(
      r.stderr,
      /--from-line and --lines both choose which lines to send; give one or the other/,
    );
  } finally {
    rm(file);
  }
});

test("malformed selectors are each a 2 naming what was wrong — never a fallback to the whole file", async () => {
  const file = tmpFile("q.jsonl", `${runLine("1")}\n`);
  const cases: [string[], RegExp][] = [
    [["--from-line", "0", file], /--from-line must be 1 or greater, got 0/],
    [["--from-line", "twelve", file], /--from-line wants a line number, got "twelve"/],
    [["--from-line"], /missing argument: --from-line/],
    [["--lines", "", file], /--lines needs at least one line number, got ""/],
    [["--lines", "3,,", file], /--lines has an empty entry in "3,,"/],
    [["--lines", "3-", file], /"3-" is not a line number or a N-M range/],
    [["--lines", "abc", file], /"abc" is not a line number or a N-M range/],
    [["--lines", "5 - 7", file], /"5 - 7" is not a line number or a N-M range/],
    [["--lines", "0", file], /line numbers start at 1, got "0"/],
    [["--lines", "5-2", file], /"5-2" ends before it starts/],
  ];
  try {
    for (const [argv, pattern] of cases) {
      const r = await runCli(argv, "http://127.0.0.1:1");
      assert.equal(r.code, 2, `expected 2 for: ${argv.join(" ")}`);
      assert.match(r.stderr, pattern);
    }
  } finally {
    rm(file);
  }
});

test("whitespace between --lines entries is allowed; inside one it is a typo", async () => {
  const contents = [1, 2, 3].map((i) => runLine(`run-${i}`)).join("\n") + "\n";
  const file = tmpFile("q.jsonl", contents);
  try {
    const r = await runCli(["--list", "--lines", "1, 3", file]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("run-1"));
    assert.ok(r.stdout.includes("run-3"));
    assert.ok(!r.stdout.includes("run-2"));
  } finally {
    rm(file);
  }
});

test("a selector past the end of the file selects nothing: exit 0, stderr warning naming the held-back count", async () => {
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"tr_1"}' });
  try {
    const file = tmpFile("q.jsonl", `${runLine("1")}\n${runLine("2")}\n`);
    const r = await runCli(["--from-line", "9", file], srv.url);
    assert.equal(r.code, 0);
    assert.equal(srv.bodies.length, 0, "nothing is sent when the selector names nothing");
    assert.match(r.stderr, /holds no runs to deliver \(2 earlier lines skipped by --from-line\)/);
    assert.equal(r.stdout, "");
    rm(file);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// Delivery against a capture server

test("delivery: every line is POSTed byte-for-byte — the body equals the file line exactly", async () => {
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"41f2c9b8"}' });
  try {
    // The injected double space and the trailing-zero `1.50` are
    // load-bearing: a parse-then-re-stringify would collapse the space and
    // emit `1.5`, so this line FAILS the exactness assertion under
    // re-stringification — the assertion is not vacuous.
    const lineA = runLine("17442").replace('"duration_seconds":1.50', '"duration_seconds":  1.50');
    const lineB = runLine("17442");
    const file = tmpFile("q.jsonl", `${lineA}\n${lineB}\n`);
    const r = await runCli([file], srv.url);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(srv.bodies.length, 2);
    assert.equal(srv.bodies[0], lineA, "line 1 must arrive as its own bytes");
    assert.equal(srv.bodies[1], lineB, "line 2 must arrive as its own bytes");
    assert.notEqual(srv.bodies[0], JSON.stringify(JSON.parse(lineA)),
      "guard: this line must be one a re-stringify would change");
    rm(file);
  } finally {
    await srv.close();
  }
});

test("delivery: a lone-surrogate escape is delivered as its own bytes — the endpoint renders the verdict, not the tool", async () => {
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"tr_x"}' });
  try {
    // The line's TEXT contains the six ASCII characters \ud800. Node's
    // JSON.parse accepts the escape where the protocol rejects it; routing
    // the body through a repaired JS string would substitute U+FFFD. The
    // POST must carry the original bytes, and the tool must not pre-refuse
    // the line on the strength of its own looser parser.
    const line = '{"commit_sha":"abc","branch":"main","specs":[{"name":"\\ud800","file_path":"a.test.js","line_number":1,"outcome":"passed","status":"unannotated","intent":null,"id":"x","duration":null}]}';
    const file = tmpFile("q.jsonl", `${line}\n`);
    const r = await runCli([file], srv.url);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(srv.bodies.length, 1);
    assert.equal(srv.bodies[0], line, "the escaped surrogate's bytes must survive the trip");
    assert.ok(!srv.bodies[0]!.includes("\uFFFD"), "no silent U+FFFD repair");
    rm(file);
  } finally {
    await srv.close();
  }
});

test("delivery: 202s are accepted, reported per line, folded where observed", async () => {
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"41f2c9b8"}' });
  try {
    const file = tmpFile("q.jsonl", `${runLine("17442")}\n${runLine("17442")}\n${runLine("999")}\n`);
    const r = await runCli([file], srv.url);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /line 1: accepted — HTTP 202, test_run_id 41f2c9b8, ci_run_id 17442/);
    assert.match(r.stdout, /line 2: accepted — HTTP 202, test_run_id 41f2c9b8, ci_run_id 17442/);
    assert.match(r.stdout, /line 3: accepted — HTTP 202, test_run_id 41f2c9b8, ci_run_id 999/);
    assert.match(r.stdout, /specguard-ingest: delivered 3 of 3 runs from /);
    assert.match(
      r.stdout,
      /specguard-ingest: lines 1, 2 carried ci_run_id 17442 and each came back with test_run_id 41f2c9b8 — the endpoint folded them onto one run/,
    );
    // Folding is stated ONLY where observed: line 3's ci_run_id is its own.
    assert.ok(!/lines 1, 2, 3|lines 2, 3/.test(r.stdout));
    rm(file);
  } finally {
    await srv.close();
  }
});

test("delivery: a 202 body without a test_run_id is still an acceptance, reported as '(not reported)'", async () => {
  const srv = await captureServer({ status: 202, body: "" });
  try {
    const file = tmpFile("q.jsonl", `${runLine("17")}\n`);
    const r = await runCli([file], srv.url);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /line 1: accepted — HTTP 202, test_run_id \(not reported\), ci_run_id 17/);
    rm(file);
  } finally {
    await srv.close();
  }
});

test("exit 1 is ONLY the endpoint's content verdict: a 400 refuses, a 401/429/500 do not", async () => {
  for (const status of [401, 429, 500]) {
    const srv = await captureServer({ status, body: "boom" });
    try {
      const file = tmpFile("q.jsonl", `${runLine("17")}\n`);
      const r = await runCli([file], srv.url);
      assert.equal(r.code, 2, `a ${status} is the tool's problem, never the run's`);
      assert.match(r.stdout, new RegExp(`line 1: not delivered — HTTP ${status} — boom`));
      assert.match(r.stdout, /delivered 0 of 1 run from /);
      rm(file);
    } finally {
      await srv.close();
    }
  }

  const srv = await captureServer({ status: 400, body: "specs is required and must be an array" });
  try {
    const file = tmpFile("q.jsonl", `${runLine("17")}\n`);
    const r = await runCli([file], srv.url);
    assert.equal(r.code, 1, "a 400 is the one permanent content verdict");
    assert.match(r.stdout, /line 1: refused — HTTP 400 — specs is required and must be an array/);
    assert.match(r.stdout, /1 refused/);
    rm(file);
  } finally {
    await srv.close();
  }
});

test("a mixed file: 2 dominates 1 — the undelivered line is the fact that leaves work undone", async () => {
  // Sequence: line 1 (accepted), line 2 (refused 400), line 3 (undelivered 401).
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"tr_1"}' }, [
    { status: 202, body: '{"test_run_id":"tr_1"}' },
    { status: 400, body: "nope" },
    { status: 401, body: "unauthorized" },
  ]);
  try {
    const file = tmpFile("q.jsonl", `${runLine("1")}\n${runLine("2")}\n${runLine("3")}\n`);
    const r = await runCli([file], srv.url);
    assert.equal(r.code, 2);
    assert.match(r.stdout, /line 1: accepted/);
    assert.match(r.stdout, /line 2: refused — HTTP 400 — nope/);
    assert.match(r.stdout, /line 3: not delivered — HTTP 401 — unauthorized/);
    assert.match(r.stdout, /delivered 1 of 3 runs from .*; 1 refused; 1 could not be delivered/);
    rm(file);
  } finally {
    await srv.close();
  }
});

test("an unparseable line on delivery is a 2, named by line number, and stops nothing else", async () => {
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"tr_1"}' });
  try {
    const file = tmpFile("q.jsonl", `${runLine("1")}\nthis is not json\n${runLine("3")}\n`);
    const r = await runCli([file], srv.url);
    assert.equal(r.code, 2);
    assert.match(r.stdout, /line 2: unparseable — could not parse the line as JSON/);
    assert.match(r.stdout, /line 1: accepted/);
    assert.match(r.stdout, /line 3: accepted/);
    assert.match(r.stdout, /1 could not be parsed/);
    assert.equal(srv.bodies.length, 2, "the good lines still delivered");
    rm(file);
  } finally {
    await srv.close();
  }
});

test("a line that parses to a non-object is unparseable, naming what it is", async () => {
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"tr_1"}' });
  try {
    const file = tmpFile("q.jsonl", `[1,2]\n"just a string"\n${runLine("1")}\n`);
    const r = await runCli([file], srv.url);
    assert.equal(r.code, 2);
    assert.match(r.stdout, /line 1: unparseable — the line is an array JSON, and a run is an object/);
    assert.match(r.stdout, /line 2: unparseable — the line is a string JSON, and a run is an object/);
    rm(file);
  } finally {
    await srv.close();
  }
});

test("a line that is not valid UTF-8 is unparseable on delivery — a verdict, not a crash", async () => {
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"tr_1"}' });
  try {
    const file = tmpFile("q.jsonl", Buffer.concat([
      Buffer.from(runLine("1"), "utf8"), Buffer.from([0x0a]),
      Buffer.from([0xff, 0xfe, 0xff]), Buffer.from([0x0a]),
    ]));
    const r = await runCli([file], srv.url);
    assert.equal(r.code, 2);
    assert.match(r.stdout, /line 2: unparseable — the line is not valid UTF-8, so it cannot be a run/);
    assert.equal(srv.bodies.length, 1, "the good line still delivered");
    rm(file);
  } finally {
    await srv.close();
  }
});

test("a network failure is a 2 reported as not delivered — never a refused run", async () => {
  // Port 1 on 127.0.0.1: connection refused, nothing reached an endpoint.
  const file = tmpFile("q.jsonl", `${runLine("17")}\n`);
  try {
    const r = await runCli([file], "http://127.0.0.1:1");
    assert.equal(r.code, 2);
    assert.match(r.stdout, /line 1: not delivered — /);
    assert.match(r.stdout, /1 could not be delivered/);
  } finally {
    rm(file);
  }
});

test("blank lines are counted and skipped, singular and plural, and advance the numbering", async () => {
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"tr_1"}' });
  try {
    const file = tmpFile("q.jsonl", `${runLine("1")}\n\n   \n${runLine("2")}\n`);
    const r = await runCli([file], srv.url);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /line 4: accepted/);
    assert.match(r.stdout, /delivered 2 of 2 runs from .*; 2 blank lines skipped/);
    assert.equal(srv.bodies.length, 2);
    rm(file);

    const one = tmpFile("one.jsonl", `\n${runLine("1")}\n`);
    const r1 = await runCli([one], srv.url);
    assert.match(r1.stdout, /1 blank line skipped/);
    rm(one);
  } finally {
    await srv.close();
  }
});

test("a line over the gzip threshold rides the shared seam: gzipped, and the body still exact", async () => {
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"tr_1"}' });
  try {
    const filler = "x".repeat(300 * 1024);
    const line = `{"commit_sha":"abc","branch":"main","specs":[{"name":"${filler}","file_path":"a.test.js","line_number":1,"outcome":"passed","status":"unannotated","intent":null,"id":"x","duration":null}]}`;
    assert.ok(Buffer.byteLength(line, "utf8") > 256 * 1024);
    const file = tmpFile("q.jsonl", `${line}\n`);
    const r = await runCli([file], srv.url);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(srv.encodings[0], "gzip", "the replay shares the delivery path's gzip threshold");
    assert.equal(srv.bodies[0], line);
    rm(file);
  } finally {
    await srv.close();
  }
});

test("the request carries the Authorization header and the specguard-ts User-Agent", async () => {
  let auth: string | undefined;
  let ua: string | undefined;
  const server = http.createServer((req, res) => {
    auth = req.headers.authorization;
    ua = req.headers["user-agent"];
    res.statusCode = 202;
    res.end('{"test_run_id":"tr_1"}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    const file = tmpFile("q.jsonl", `${runLine("17")}\n`);
    const r = await runCli([file], `http://127.0.0.1:${port}`);
    assert.equal(r.code, 0);
    assert.equal(auth, "Bearer sgk_ingest_test");
    assert.match(ua ?? "", /^specguard-ts\//);
    rm(file);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("an empty file is a loud exit 0: 'there was nothing to do' is a warning, not a code", async () => {
  const file = tmpFile("e.jsonl", "");
  try {
    const r = await runCli([file], "http://127.0.0.1:1");
    assert.equal(r.code, 0);
    assert.match(r.stderr, /specguard-ingest: warning: .* holds no runs to deliver\n$/);
    assert.equal(r.stdout, "");
  } finally {
    rm(file);
  }
});

test("--help prints usage and exits 0", async () => {
  const r = await runCli(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage: specguard-ingest \[--list\] \[--from-line N \| --lines SPEC\] <file>/);
  assert.match(r.stdout, /Exit codes:/);
  assert.match(r.stdout, /0  every line was accepted/);
});

// ---------------------------------------------------------------------------
// The bin itself — the compiled entry, run as a child process

test("bin: the compiled entry replays a file against a capture server (202 → exit 0, byte-for-byte)", async () => {
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"41f2c9b8"}' });
  try {
    const line = runLine("17442");
    const file = tmpFile("q.jsonl", `${line}\n`);
    const { stdout } = await execFileAsync(process.execPath, [
      join(here, "..", "src", "ingest-cli.js"),
      file,
    ], {
      env: {
        ...process.env,
        SPECGUARD_ENDPOINT: srv.url,
        SPECGUARD_API_KEY: "sgk_ingest_test",
        SPECGUARD_TIMEOUT: "2",
      },
    });
    assert.match(stdout, /line 1: accepted — HTTP 202, test_run_id 41f2c9b8, ci_run_id 17442/);
    assert.equal(srv.bodies[0], line, "the child bin delivers byte-for-byte too");
    rm(file);
  } finally {
    await srv.close();
  }
});

test("bin: a module that cannot load is a 2 with one stderr line, never a stack trace", async () => {
  // A copy of the compiled bin whose lazy import points at nothing — the
  // load-failure limb of the never-throw contract.
  const dir = mkdtempSync(join(tmpdir(), "specguard-ingest-bin-"));
  try {
    const broken = join(dir, "ingest-cli.js");
    const original = readFileSync(join(here, "..", "src", "ingest-cli.js"), "utf8");
    writeFileSync(broken, original.replace("./core/ingest-cli.js", "./core/does-not-exist.js"));
    const result = await execFileAsync(process.execPath, [broken, "/nonexistent/file.jsonl"]).then(
      (ok: { stdout: string; stderr: string }) => ({ code: 0, stderr: ok.stderr }),
      (err: { code: number; stderr: string }) => ({ code: err.code, stderr: err.stderr }),
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /specguard-ingest: error: could not load specguard-ts: /);
    assert.ok(!result.stderr.includes("\n    at "), "no stack trace on a load failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
