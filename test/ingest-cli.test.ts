import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { run } from "../src/core/ingest-cli.js";
import { version } from "../src/core/transport.js";

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
    assert.equal(ua, `specguard-ts/${version()}`);
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
    assert.match(result.stderr, /specguard-ingest: error: could not load @yatfa\/specguard: /);
    assert.ok(!result.stderr.includes("\n    at "), "no stack trace on a load failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The installed shape: a bin reached through the symlink npm creates

test("REGRESSION: both bins run through the symlink npm installs them as", async () => {
  // npm links a bin as `node_modules/.bin/<name> -> ../<pkg>/dist/<file>.js`,
  // and Node reports the LINK's own path in `process.argv[1]` rather than the
  // target's. The main-module guard used to match on the filename, so through
  // an installed bin it read false: the process loaded, ran nothing and exited
  // 0 — a silent no-op no consumer could diagnose. Every other test here
  // invokes the file BY PATH, where the old guard was true, which is exactly
  // why nothing caught it. This one runs the shipped `dist/` files the way an
  // install does.
  const pkgRoot = join(here, "..", "..");
  const dir = mkdtempSync(join(tmpdir(), "specguard-bin-link-"));
  const cases = [
    { link: "specguard", target: join(pkgRoot, "dist", "cli.js"), want: /Usage: specguard lint/ },
    { link: "specguard-ingest", target: join(pkgRoot, "dist", "ingest-cli.js"), want: /no file given — Usage: specguard-ingest/ },
  ];
  try {
    for (const { link, target, want } of cases) {
      const linkPath = join(dir, link);
      symlinkSync(target, linkPath);
      const result = await execFileAsync(process.execPath, [linkPath]).then(
        (ok: { stdout: string; stderr: string }) => ({ code: 0, output: ok.stdout + ok.stderr }),
        (err: { code: number; stdout: string; stderr: string }) => ({ code: err.code, output: err.stdout + err.stderr }),
      );
      assert.equal(result.code, 2, `${link} through a symlink must not be a silent no-op (exit 0, no output)`);
      assert.match(result.output, want);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- SPGD-1188: the version identity ----------------------------------------
//
// Mirrors the Ruby ingest bin's `-v/--version` (and the lint CLI's slice
// above): one line `specguard-ts <version>`, exit 0, BEFORE the no-file
// UsageError, the endpoint/API-key checks and any file read. The string is
// the SAME version() the User-Agent stamps on every delivery. The FORMAT is
// pinned against the live package version — never a literal.

test("SPGD-1188: --version and -v print one identity line and exit 0 with NO file argument", async () => {
  const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")) as {
    version: string;
  };
  const expected = `specguard-ts ${pkg.version}\n`;
  for (const argv of [["--version"], ["-v"]]) {
    // No endpoint and no API key configured: the identity run must exit 0
    // anyway, proving it never reaches the credential checks (or the
    // no-file check this invocation would otherwise die on).
    const r = await runCli(argv);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, expected);
    assert.equal(r.stderr, "");
  }
});

test("SPGD-1188: --version wins before any file is read — even a nonexistent one", async () => {
  // If the file were opened, ENOENT would become "no such file" (exit 2);
  // the identity line + exit 0 proves the parse short-circuits before any
  // file read, exactly like --help does.
  const r = await runCli(["--version", "no-such-file.jsonl"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^specguard-ts \d+\.\d+\.\d+\n$/);
  assert.equal(r.stderr, "");
});

test("SPGD-1188: near-miss flags are NOT swallowed by the version arm", async () => {
  for (const flag of ["--versions", "--ver"]) {
    const r = await runCli([flag]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, new RegExp(`invalid option: ${flag}`));
    assert.equal(r.stdout, "");
  }
});

test("SPGD-1188: --help describes -v, --version and keeps the usage banner", async () => {
  const r = await runCli(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /-v, --version/);
  assert.match(r.stdout, /Usage: specguard-ingest \[--list\] \[--from-line N \| --lines SPEC\] <file>/);
});

// --- SPGD-1226: the refusal parse reaches the report, and --json -------------
//
// HTTP 400 is the only PERMANENT verdict in this command's contract — a
// refused line is refused every time it is offered — so the only way to land
// the run is to learn which specs the platform objected to. The human line
// flattens the refusal body to 300 characters; `--json` is the second channel
// that cap's own grounds hand over: one JSON document on stdout, every reason
// in it, over the same lines, the same counts and the same exit code.

/** N distinct per-spec refusal errors, as the platform sends them. */
function detailSpecs(n: number): string[] {
  return Array.from(
    { length: n },
    (_, i) =>
      `specs[${i}] spec/models/user_spec.rb:${100 + i}: duration must be a non-negative number when present`,
  );
}

function parseDocument(stdout: string): Record<string, unknown> {
  // AC 2's falsifier for today's `Unterminated string in JSON at position 301`:
  // the WHOLE stdout must parse as one document.
  return JSON.parse(stdout) as Record<string, unknown>;
}

test("SPGD-1226: a 400's details array reaches the report — every spec named under --json, the human line still capped", async () => {
  const specs = detailSpecs(25);
  const body = JSON.stringify({ error: "bad_request", message: specs[0], details: specs });

  // WITHOUT --json: the human line is byte-for-byte what it has always been —
  // the flattened refusal fragment, hard-truncated at 300 characters.
  const srv1 = await captureServer({ status: 400, body });
  try {
    const file = tmpFile("q.jsonl", `${runLine("17")}\n`);
    const r = await runCli([file], srv1.url);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /line 1: refused — HTTP 400 — \{"error"/);
    assert.ok(r.stdout.includes("specs[0]"));
    assert.ok(!r.stdout.includes("specs[24]"), "the human line has room for a fragment, not the list");
    const refusedLine = r.stdout.split("\n")[0] ?? "";
    assert.ok(
      refusedLine.endsWith("…"),
      `the truncation the 300-character cap has always produced: ${refusedLine.slice(-40)}`,
    );
    rm(file);
  } finally {
    await srv1.close();
  }

  // WITH --json: one document, every reason, uncapped, in the platform's order.
  const srv2 = await captureServer({ status: 400, body });
  try {
    const file = tmpFile("q.jsonl", `${runLine("17")}\n`);
    const r = await runCli(["--json", file], srv2.url);
    assert.equal(r.code, 1, "the exit code is identical with the flag");
    const doc = parseDocument(r.stdout);
    assert.equal(doc.tool, "specguard-ingest");
    assert.equal(doc.mode, "deliver");
    const line = (doc.lines as Record<string, unknown>[])[0]!;
    assert.equal(line.status, "refused");
    assert.equal(line.code, 400);
    assert.equal(line.test_run_id, null);
    assert.equal(line.ci_run_id, "17");
    assert.deepEqual(line.reasons, specs, "every offending spec, no cap, no ellipsis, no truncation");
    assert.equal((doc.summary as Record<string, unknown>).refused, 1);
    assert.equal(r.stderr, "");
    rm(file);
  } finally {
    await srv2.close();
  }
});

test("SPGD-1226: the --json document carries the published shape over a mixed file", async () => {
  const specs = detailSpecs(4);
  const refusedBody = JSON.stringify({ error: "bad_request", message: specs[0], details: specs });
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"tr_1"}' }, [
    { status: 202, body: '{"test_run_id":"tr_1"}' },
    { status: 400, body: refusedBody },
    { status: 401, body: "unauthorized" },
  ]);
  try {
    const file = tmpFile(
      "q.jsonl",
      `${runLine("run-1")}\n${runLine("run-2")}\n${runLine("run-3")}\nnot json at all\n`,
    );
    const r = await runCli(["--json", file], srv.url);
    assert.equal(r.code, 2, "2 dominates, with the flag exactly as without");
    const doc = parseDocument(r.stdout);
    assert.deepEqual(Object.keys(doc), ["tool", "mode", "file", "summary", "lines", "foldings"]);
    assert.equal(doc.mode, "deliver");
    assert.equal(doc.file, file);
    assert.deepEqual(doc.summary, {
      lines: 4,
      attempted: 3,
      accepted: 1,
      refused: 1,
      undelivered: 1,
      unparseable: 1,
      blank: 0,
      skipped: 0,
      selector: null,
    });
    const lines = doc.lines as Record<string, unknown>[];
    assert.deepEqual(lines[0], {
      number: 1,
      status: "accepted",
      code: 202,
      reasons: [],
      test_run_id: "tr_1",
      ci_run_id: "run-1",
    });
    assert.deepEqual(lines[1], {
      number: 2,
      status: "refused",
      code: 400,
      reasons: specs,
      test_run_id: null,
      ci_run_id: "run-2",
    });
    // 401: arrived, stored nothing, said nothing readable — reasons [].
    assert.deepEqual(lines[2], {
      number: 3,
      status: "undelivered",
      code: 401,
      reasons: [],
      test_run_id: null,
      ci_run_id: "run-3",
    });
    const unparseable = lines[3] as Record<string, unknown>;
    assert.equal(unparseable.number, 4);
    assert.equal(unparseable.status, "unparseable");
    assert.equal(unparseable.code, null);
    assert.equal(unparseable.test_run_id, null);
    assert.equal(unparseable.ci_run_id, null);
    assert.ok(
      Array.isArray(unparseable.reasons) &&
        unparseable.reasons.length === 1 &&
        String(unparseable.reasons[0]).startsWith("could not parse the line as JSON:"),
      JSON.stringify(unparseable.reasons),
    );
    assert.deepEqual(doc.foldings, []);
    assert.equal(r.stderr, "", "no warning when the run had results — either renderer");
    rm(file);
  } finally {
    await srv.close();
  }
});

test("SPGD-1226: foldings render as data — the same observation the text report states as a sentence", async () => {
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"41f2c9b8"}' });
  try {
    const file = tmpFile("q.jsonl", `${runLine("17442")}\n${runLine("17442")}\n${runLine("999")}\n`);
    const r = await runCli(["--json", file], srv.url);
    assert.equal(r.code, 0);
    const doc = parseDocument(r.stdout);
    assert.deepEqual(doc.foldings, [
      { ci_run_id: "17442", test_run_id: "41f2c9b8", lines: [1, 2] },
    ]);
    assert.deepEqual(doc.summary, {
      lines: 3,
      attempted: 3,
      accepted: 3,
      refused: 0,
      undelivered: 0,
      unparseable: 0,
      blank: 0,
      skipped: 0,
      selector: null,
    });
    rm(file);
  } finally {
    await srv.close();
  }
});

test("SPGD-1226: a delivery that never got an answer carries code null and the error as its one reason", async () => {
  const file = tmpFile("q.jsonl", `${runLine("17")}\n`);
  try {
    const r = await runCli(["--json", file], "http://127.0.0.1:1");
    assert.equal(r.code, 2);
    const doc = parseDocument(r.stdout);
    const line = (doc.lines as Record<string, unknown>[])[0]!;
    assert.equal(line.status, "undelivered");
    assert.equal(line.code, null, "no answer, no code");
    const reasons = line.reasons as string[];
    assert.equal(reasons.length, 1, "the error's rendering is the whole of what there is to say");
    assert.equal(typeof reasons[0], "string");
    assert.ok(reasons[0]!.length > 0);
    rm(file);
  } finally {
    rm(file);
  }
});

test("SPGD-1241: under --json an invalid-UTF-8 line's document row carries the UTF-8 verdict in reasons, not a folded empty list", async () => {
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"tr_1"}' });
  try {
    const file = tmpFile("q.jsonl", Buffer.concat([
      Buffer.from(runLine("1"), "utf8"), Buffer.from([0x0a]),
      Buffer.from([0xff, 0xfe, 0xff]), Buffer.from([0x0a]),
    ]));
    const r = await runCli(["--json", file], srv.url);
    assert.equal(r.code, 2);
    const doc = parseDocument(r.stdout);
    const lines = doc.lines as Record<string, unknown>[];
    // The whole row, per the file's whole-row idiom. `reasons` is the
    // document's ONLY statement of why this line failed — the text row's
    // `detail` happens to carry the same string, but a document consumer
    // never sees the text row, and reasons(null) would fold to [].
    assert.deepEqual(lines[1], {
      number: 2,
      status: "unparseable",
      code: null,
      reasons: ["the line is not valid UTF-8, so it cannot be a run"],
      test_run_id: null,
      ci_run_id: null,
    });
    assert.equal(srv.bodies.length, 1, "the good line still delivered");
    rm(file);
  } finally {
    await srv.close();
  }
});

test("SPGD-1226: --list --json lists the envelope facts as values and delivers nothing", async () => {
  const file = tmpFile(
    "q.jsonl",
    `${runLine("17442")}\n{"commit_sha":"abc123"}\nnot json at all\n`,
  );
  try {
    // Deliberately no server: listing needs no credentials, with or without --json.
    const r = await runCli(["--list", "--json", file]);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, "");
    const doc = parseDocument(r.stdout);
    assert.equal(doc.mode, "list");
    assert.deepEqual(doc.summary, {
      lines: 3,
      attempted: 0,
      accepted: 0,
      refused: 0,
      undelivered: 0,
      unparseable: 1,
      blank: 0,
      skipped: 0,
      selector: null,
    });
    const lines = doc.lines as Record<string, unknown>[];
    assert.deepEqual(lines[0], {
      number: 1,
      status: "listed",
      reasons: [],
      branch: "main",
      commit_sha: "0d4a1f2c9b8e7d6a5f4c3b2a1908f7e6d5c4b3a2",
      ci_run_id: "17442",
      examples: 1,
      duration_seconds: 1.5,
    });
    assert.deepEqual(lines[1], {
      number: 2,
      status: "listed",
      reasons: [],
      branch: null,
      commit_sha: "abc123",
      ci_run_id: null,
      examples: null,
      duration_seconds: null,
    });
    const unparseable = lines[2] as Record<string, unknown>;
    assert.equal(unparseable.status, "unparseable");
    assert.ok(
      Array.isArray(unparseable.reasons) &&
        unparseable.reasons.length === 1 &&
        String(unparseable.reasons[0]).startsWith("could not parse the line as JSON:"),
    );
    assert.deepEqual(doc.foldings, []);
    rm(file);
  } finally {
    rm(file);
  }
});

test("SPGD-1226: an empty file emits a document under --json — the file was read, and lines [] over zeroes is true", async () => {
  const empty = tmpFile("e.jsonl", "");
  try {
    const run = await runCli(["--json", empty], "http://127.0.0.1:1");
    assert.equal(run.code, 0);
    assert.match(run.stderr, /holds no runs to deliver\n$/, "the warning stays on stderr in BOTH renderers");
    const doc = parseDocument(run.stdout);
    assert.equal(doc.mode, "deliver");
    assert.deepEqual(doc.lines, []);
    assert.deepEqual(doc.foldings, []);
    assert.deepEqual(doc.summary, {
      lines: 0,
      attempted: 0,
      accepted: 0,
      refused: 0,
      undelivered: 0,
      unparseable: 0,
      blank: 0,
      skipped: 0,
      selector: null,
    });

    const listed = await runCli(["--list", "--json", empty]);
    assert.equal(listed.code, 0);
    assert.match(listed.stderr, /holds no runs to list\n$/);
    const ldoc = parseDocument(listed.stdout);
    assert.equal(ldoc.mode, "list");
    assert.deepEqual(ldoc.lines, []);
    rm(empty);
  } finally {
    rm(empty);
  }
});

test("SPGD-1226: a run that never got as far as reading <file> writes no document — bad flag, missing credentials", async () => {
  const file = tmpFile("q.jsonl", `${runLine("17")}\n`);
  try {
    const badFlag = await runCli(["--dry-runn", "--json", file]);
    assert.equal(badFlag.code, 2);
    assert.equal(badFlag.stdout, "", "no document for a run that never read the file");

    const noCreds = await runCli(["--json", file]);
    assert.equal(noCreds.code, 2);
    assert.equal(noCreds.stdout, "");

    // --list still needs no credentials under --json: the file most worth
    // checking is the one written because no key was set.
    const listed = await runCli(["--list", "--json", file]);
    assert.equal(listed.code, 0);
    assert.notEqual(listed.stdout, "");
    rm(file);
  } finally {
    rm(file);
  }
});

test("SPGD-1226: the exit code is identical with and without --json, on 0, 1 and 2", async () => {
  const ok = await captureServer({ status: 202, body: '{"test_run_id":"tr_1"}' });
  try {
    const f0 = tmpFile("f0.jsonl", `${runLine("1")}\n`);
    assert.equal((await runCli([f0], ok.url)).code, 0);
    assert.equal((await runCli(["--json", f0], ok.url)).code, 0);
    rm(f0);
  } finally {
    await ok.close();
  }

  const refused = await captureServer({ status: 400, body: "specs is required and must be an array" });
  try {
    const f1 = tmpFile("f1.jsonl", `${runLine("1")}\n`);
    assert.equal((await runCli([f1], refused.url)).code, 1);
    assert.equal((await runCli(["--json", f1], refused.url)).code, 1);
    rm(f1);
  } finally {
    await refused.close();
  }

  const f2 = tmpFile("f2.jsonl", `${runLine("1")}\n`);
  try {
    assert.equal((await runCli([f2], "http://127.0.0.1:1")).code, 2);
    assert.equal((await runCli(["--json", f2], "http://127.0.0.1:1")).code, 2);
  } finally {
    rm(f2);
  }
});

test("SPGD-1226: the summary names the selector only when it demonstrably held something back", async () => {
  const contents = [1, 2, 3, 4].map((i) => runLine(`run-${i}`)).join("\n") + "\n";
  const file = tmpFile("q.jsonl", contents);
  try {
    const from = await runCli(["--json", "--from-line", "3", file], "http://127.0.0.1:1");
    let doc = parseDocument(from.stdout);
    let summary = doc.summary as Record<string, unknown>;
    assert.equal(summary.selector, "--from-line");
    assert.equal(summary.skipped, 2);
    assert.equal(summary.lines, 2);

    const set = await runCli(["--json", "--lines", "2,4", file], "http://127.0.0.1:1");
    doc = parseDocument(set.stdout);
    assert.equal((doc.summary as Record<string, unknown>).selector, "--lines");

    const none = await runCli(["--json", file], "http://127.0.0.1:1");
    doc = parseDocument(none.stdout);
    assert.equal((doc.summary as Record<string, unknown>).selector, null);
    rm(file);
  } finally {
    rm(file);
  }
});

test("SPGD-1226: blank lines are counted in the document, not dropped, and numbering is the file's", async () => {
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"tr_1"}' });
  try {
    const file = tmpFile("q.jsonl", `${runLine("1")}\n\n   \n${runLine("2")}\n`);
    const r = await runCli(["--json", file], srv.url);
    assert.equal(r.code, 0);
    const doc = parseDocument(r.stdout);
    assert.equal((doc.summary as Record<string, unknown>).blank, 2);
    assert.deepEqual(
      (doc.lines as { number: number }[]).map((l) => l.number),
      [1, 4],
    );
    rm(file);
  } finally {
    await srv.close();
  }
});

test("SPGD-1226: no single-dash parse changed — -j is not a short form, and near-misses are still refused", async () => {
  const file = tmpFile("q.jsonl", `${runLine("1")}\n`);
  try {
    const j = await runCli(["-j", file]);
    assert.equal(j.code, 2);
    assert.match(j.stderr, /one file at a time, got 2: -j, /);

    for (const flag of ["--jsonx", "--js"]) {
      const r = await runCli([flag, file]);
      assert.equal(r.code, 2);
      assert.match(r.stderr, new RegExp(`invalid option: ${flag}`));
      assert.equal(r.stdout, "");
    }
    rm(file);
  } finally {
    rm(file);
  }
});

test("SPGD-1226: --version and --help keep short-circuiting before --json is considered", async () => {
  for (const argv of [["--version", "--json"], ["--json", "--version"]]) {
    const v = await runCli(argv);
    assert.equal(v.code, 0);
    assert.match(v.stdout, /^specguard-ts \d+\.\d+\.\d+\n$/);
    assert.equal(v.stderr, "");
  }
  const h = await runCli(["--help", "--json"]);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /Usage: specguard-ingest/);

  // A bare --json with no file is still the no-file UsageError, not a JSON run.
  const noFile = await runCli(["--json"]);
  assert.equal(noFile.code, 2);
  assert.match(noFile.stderr, /no file given — Usage: specguard-ingest/);
  assert.equal(noFile.stdout, "");
});

test("SPGD-1226: --help documents --json in its Options block; the banner text is untouched", async () => {
  const r = await runCli(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /  --json            Emit one JSON document on stdout instead of the human report\n/);
  assert.match(r.stdout, /Usage: specguard-ingest \[--list\] \[--from-line N \| --lines SPEC\] <file>/);
});
