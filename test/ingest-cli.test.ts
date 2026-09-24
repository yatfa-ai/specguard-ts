import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, appendFileSync, chmodSync, lstatSync, readdirSync, statSync, readlinkSync } from "node:fs";
import { chmod, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { run, type DrainFs } from "../src/core/ingest-cli.js";
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
// SPGD-1442: the refusal is the one moment a keyless developer can be told
// where their run actually went — the help points them at the replay queue
// while their keyless run wrote the local record beside it. The clause is
// guarded on the conjunction — the missing path IS the configured replay
// queue AND the configured local record EXISTS — so an ordinary typo, or a
// missing pair, keeps the plain message byte-for-byte. Every path here is an
// override (SPECGUARD_OUTPUT_PATH / SPECGUARD_LOCAL_OUTPUT_PATH): the clause
// must key on the CONFIGURED pair, never on a hard-coded default, and
// absolute tmp paths keep these pins cwd-independent.

/** A scratch dir with an overridden sink pair; the local record is written only on demand. */
function sinkDir(withLocal: boolean): { dir: string; queue: string; local: string } {
  const dir = mkdtempSync(join(tmpdir(), "specguard-ingest-sinks-"));
  const queue = join(dir, "queue.jsonl");
  const local = join(dir, "local.jsonl");
  if (withLocal) writeFileSync(local, `${runLine("17")}\n`);
  return { dir, queue, local };
}

function sinkOverrides(queue: string, local: string): Record<string, string> {
  return { SPECGUARD_OUTPUT_PATH: queue, SPECGUARD_LOCAL_OUTPUT_PATH: local };
}

test("SPGD-1442: a missing replay queue with a local record present names the record in the refusal", async () => {
  const { dir, queue, local } = sinkDir(true);
  try {
    const r = await runCli([queue], "http://127.0.0.1:1", sinkOverrides(queue, local));
    assert.equal(r.code, 2);
    assert.equal(
      r.stderr,
      `specguard-ingest: error: no such file: ${queue} — the replay queue was never ` +
        `written, but the local record ${local} does exist (what the reporters write ` +
        `when no API key is configured)\n`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The same clause through the arm that exists for exactly this developer: a
// keyless --list, where no credentials are configured and no transport is built.
test("SPGD-1442: the keyless --list arm names the local record too", async () => {
  const { dir, queue, local } = sinkDir(true);
  try {
    const r = await runCli(["--list", queue], null, sinkOverrides(queue, local));
    assert.equal(r.code, 2);
    assert.ok(
      r.stderr.includes(`the local record ${local} does exist`),
      `stderr should name the local record, got: ${r.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Byte-for-byte guard: the clause needs BOTH terms. No local record on disk →
// the plain message, untouched.
test("SPGD-1442: a missing configured queue with no local record keeps the plain message byte-for-byte", async () => {
  const { dir, queue, local } = sinkDir(false);
  try {
    const r = await runCli([queue], "http://127.0.0.1:1", sinkOverrides(queue, local));
    assert.equal(r.code, 2);
    assert.equal(r.stderr, `specguard-ingest: error: no such file: ${queue}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The equality term, pinned on its own: a local record merely existing is not
// enough — the missing path must BE the configured queue, or every typo would
// be redirected at whichever file happens to be configured.
test("SPGD-1442: a missing path that is not the configured queue keeps the plain message even with a local record present", async () => {
  const { dir, queue, local } = sinkDir(true);
  const gone = join(dir, "gone.jsonl");
  try {
    const r = await runCli([gone], "http://127.0.0.1:1", sinkOverrides(queue, local));
    assert.equal(r.code, 2);
    assert.equal(r.stderr, `specguard-ingest: error: no such file: ${gone}\n`);
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
      // SPGD-1358: the warning names the absent number too — a wholly-unmatched
      // selector is a typo to fix, and the warning now says which number.
      assert.match(
        r2.stderr,
        /holds no runs to list \(2 lines not selected by --lines; --lines named 9, which the file does not have\)/,
      );
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

// --- SPGD-1341: the attached (--flag=value) form of the two selectors -------

test("SPGD-1341: --from-line=N and --lines=SPEC produce byte-identical output to the space form", async () => {
  const contents = [1, 2, 3, 4].map((i) => runLine(`run-${i}`)).join("\n") + "\n";
  const file = tmpFile("q.jsonl", contents);
  try {
    const eqFrom = await runCli(["--list", "--from-line=3", file]);
    const spFrom = await runCli(["--list", "--from-line", "3", file]);
    assert.equal(eqFrom.code, 0);
    assert.equal(eqFrom.stdout, spFrom.stdout);
    assert.equal(eqFrom.stderr, spFrom.stderr);
    // Not redundant beside the equality above: two empty streams would compare
    // equal, so this proves the compared output is the real selection summary.
    assert.match(eqFrom.stdout, /2 earlier lines skipped by --from-line/);

    const eqSet = await runCli(["--list", "--lines=2,4", file]);
    const spSet = await runCli(["--list", "--lines", "2,4", file]);
    assert.equal(eqSet.code, 0);
    assert.equal(eqSet.stdout, spSet.stdout);
    assert.equal(eqSet.stderr, spSet.stderr);
    assert.match(eqSet.stdout, /2 lines not selected by --lines/);
  } finally {
    rm(file);
  }
});

test("SPGD-1341: a malformed spec in the attached form keeps the space form's message and its 2", async () => {
  const file = tmpFile("q.jsonl", `${runLine("1")}\n`);
  // Each pair is the SAME spec typed both ways: the attached form must route
  // into the same validator, so stderr is compared to the space form rather
  // than to a pattern copied by hand.
  const pairs: [string[], string[]][] = [
    [["--lines=0"], ["--lines", "0"]],
    [["--lines=5-2"], ["--lines", "5-2"]],
    [["--lines=abc"], ["--lines", "abc"]],
    [["--lines=3,,"], ["--lines", "3,,"]],
    [["--from-line=0"], ["--from-line", "0"]],
    [["--from-line=twelve"], ["--from-line", "twelve"]],
  ];
  try {
    for (const [attached, spaced] of pairs) {
      const eq = await runCli([...attached, file], "http://127.0.0.1:1");
      const sp = await runCli([...spaced, file], "http://127.0.0.1:1");
      assert.equal(eq.code, 2, `expected 2 for: ${attached.join(" ")}`);
      assert.equal(eq.stderr, sp.stderr, `message drifted for: ${attached.join(" ")}`);
    }
    // The empty value is not a special case: it routes into the same
    // validator and gets the same naming refusal, never a whole-file fallback.
    const empty = await runCli(["--from-line=", file], "http://127.0.0.1:1");
    assert.equal(empty.code, 2);
    assert.match(empty.stderr, /--from-line wants a line number, got ""/);
  } finally {
    rm(file);
  }
});

test("SPGD-1341: the attached form is still refused when both selectors are given", async () => {
  const file = tmpFile("q.jsonl", `${runLine("1")}\n`);
  try {
    const r = await runCli(["--from-line=5", "--lines=3,7", file]);
    assert.equal(r.code, 2);
    assert.match(
      r.stderr,
      /--from-line and --lines both choose which lines to send; give one or the other/,
    );
  } finally {
    rm(file);
  }
});

test("SPGD-1341: a near-miss flag with an attached value is NOT swallowed by the selector arms", async () => {
  // The teeth of the fix: a prefix match WITHOUT the "=" would accept every
  // one of these as a selector. Each must stay an `invalid option`.
  const file = tmpFile("q.jsonl", `${runLine("1")}\n`);
  const flags = [
    "--from-linex=3",
    "--from-line-x=3",
    "--linesx=2",
    "--lines-set=2",
    "--from",
    "--lin",
  ];
  try {
    for (const flag of flags) {
      const r = await runCli([flag, file], "http://127.0.0.1:1");
      assert.equal(r.code, 2, `expected 2 for: ${flag}`);
      assert.match(r.stderr, new RegExp(`invalid option: ${flag}`));
      assert.equal(r.stdout, "");
    }
  } finally {
    rm(file);
  }
});

test("SPGD-1341: last-wins holds across the two forms, in both directions", async () => {
  const contents = [1, 2, 3, 4].map((i) => runLine(`run-${i}`)).join("\n") + "\n";
  const file = tmpFile("q.jsonl", contents);
  try {
    const lines = await runCli(["--list", "--lines=1,2", "--lines", "4", file]);
    assert.equal(lines.code, 0);
    assert.ok(!lines.stdout.includes("run-1"));
    assert.ok(!lines.stdout.includes("run-2"));
    assert.ok(lines.stdout.includes("run-4"));

    const from = await runCli(["--list", "--from-line", "2", "--from-line=3", file]);
    assert.equal(from.code, 0);
    assert.ok(!from.stdout.includes("run-1"));
    assert.ok(!from.stdout.includes("run-2"));
    assert.ok(from.stdout.includes("run-3"));
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

// --- SPGD-1358: naming the --lines numbers the file does not have -----------
//
// A `--lines` entry naming a line past the end of the file used to match
// nothing, be held back by nothing and be carried by no counter — `skipped`
// counts FILE lines — so `--lines 3,99` was byte-identical to `--lines 3` on
// every channel. The port of SPGD-1328's design ends that silence: the clause
// names the typed numbers in the shorthand they were typed in, and the
// document carries them as `summary.absent` (`null` when satisfied, never
// `[]`).

test("SPGD-1358: delivering --lines 3,99 on a 5-line file differs from --lines 3 in exactly the added clause", async () => {
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"tr_1"}' });
  try {
    const contents = [1, 2, 3, 4, 5].map((i) => runLine(`run-${i}`)).join("\n") + "\n";
    const file = tmpFile("q.jsonl", contents);
    const satisfied = await runCli(["--lines", "3", file], srv.url);
    const phantom = await runCli(["--lines", "3,99", file], srv.url);
    assert.equal(satisfied.code, 0);
    assert.equal(phantom.code, 0, "a short selection is not a verdict — exit 0 unchanged");
    assert.notEqual(satisfied.stdout, phantom.stdout);
    assert.ok(!satisfied.stdout.includes("the file does not have"));
    assert.match(phantom.stdout, /--lines named 99, which the file does not have/);
    // "Exactly the added clause", measured rather than inferred: stripping the
    // clause and its separator restores the satisfied run byte for byte.
    assert.equal(
      phantom.stdout.replace("; --lines named 99, which the file does not have", ""),
      satisfied.stdout,
    );
    rm(file);
  } finally {
    await srv.close();
  }
});

test("SPGD-1358: listing --lines 3,99 on a 5-line file differs from --lines 3 in exactly the added clause", async () => {
  const contents = [1, 2, 3, 4, 5].map((i) => runLine(`run-${i}`)).join("\n") + "\n";
  const file = tmpFile("q.jsonl", contents);
  try {
    // --list is the documented route to the numbers, so a preview that
    // under-reported would hand the user a set they did not send.
    const satisfied = await runCli(["--list", "--lines", "3", file]);
    const phantom = await runCli(["--list", "--lines", "3,99", file]);
    assert.equal(satisfied.code, 0);
    assert.equal(phantom.code, 0);
    assert.equal(satisfied.stderr, "");
    assert.equal(phantom.stderr, "");
    assert.notEqual(satisfied.stdout, phantom.stdout);
    assert.ok(!satisfied.stdout.includes("the file does not have"));
    assert.match(phantom.stdout, /--lines named 99, which the file does not have/);
    assert.equal(
      phantom.stdout.replace("--lines named 99, which the file does not have; ", ""),
      satisfied.stdout,
    );
    rm(file);
  } finally {
    rm(file);
  }
});

test("SPGD-1358: --json distinguishes a satisfied selector from one naming absent lines, on both paths", async () => {
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"tr_1"}' });
  try {
    const contents = [1, 2, 3, 4, 5].map((i) => runLine(`run-${i}`)).join("\n") + "\n";
    const file = tmpFile("q.jsonl", contents);

    const satisfied = await runCli(["--json", "--lines", "3", file], srv.url);
    const doc = parseDocument(satisfied.stdout);
    // Key order is the Ruby twin's: `absent` sits between `skipped` and
    // `selector` — the two documents are key-for-key identical.
    assert.deepEqual(Object.keys(doc.summary as Record<string, unknown>), [
      "lines",
      "attempted",
      "accepted",
      "refused",
      "undelivered",
      "unparseable",
      "blank",
      "skipped",
      "absent",
      "selector",
    ]);
    assert.deepEqual(doc.summary, {
      lines: 1,
      attempted: 1,
      accepted: 1,
      refused: 0,
      undelivered: 0,
      unparseable: 0,
      blank: 0,
      skipped: 4,
      absent: null,
      selector: "--lines",
    });

    const phantom = await runCli(["--json", "--lines", "3,99", file], srv.url);
    const phantomDoc = parseDocument(phantom.stdout);
    assert.deepEqual((phantomDoc.summary as Record<string, unknown>).absent, ["99"]);
    assert.equal((phantomDoc.summary as Record<string, unknown>).skipped, 4);

    // The listing document — the preview a bridge reads before sending.
    const listedSat = await runCli(["--list", "--json", "--lines", "3", file]);
    const listedPhantom = await runCli(["--list", "--json", "--lines", "3,99", file]);
    const satSummary = parseDocument(listedSat.stdout).summary as Record<string, unknown>;
    const phSummary = parseDocument(listedPhantom.stdout).summary as Record<string, unknown>;
    assert.equal(satSummary.absent, null);
    assert.deepEqual(phSummary.absent, ["99"]);
    // Absent is the one key the two documents differ in — compared with the
    // key itself nulled on both sides, since `null` and `["99"]` are the very
    // difference under test.
    assert.deepEqual({ ...satSummary, absent: null }, { ...phSummary, absent: null });
    rm(file);
  } finally {
    await srv.close();
  }
});

test("SPGD-1358: a range only half answered names its portion past the end, in the shorthand typed", async () => {
  const contents = [1, 2, 3, 4, 5].map((i) => runLine(`run-${i}`)).join("\n") + "\n";
  const file = tmpFile("q.jsonl", contents);
  try {
    const plain = await runCli(["--list", "--lines", "4-9", file]);
    assert.equal(plain.code, 0);
    assert.match(plain.stdout, /--lines named 6-9, which the file does not have/);
    assert.ok(!plain.stdout.includes("4-9, which"), "the satisfied half is not re-named as absent");

    const json = await runCli(["--list", "--json", "--lines", "4-9", file]);
    const doc = parseDocument(json.stdout);
    assert.deepEqual((doc.summary as Record<string, unknown>).absent, ["6-9"], "never expanded");
    rm(file);
  } finally {
    rm(file);
  }
});

test("SPGD-1358: the document and the text summary name the same absent lines for one file and one spec", async () => {
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"tr_1"}' });
  try {
    // Two renderers of ONE reading of the file, so they cannot disagree about
    // which typed lines were absent — asserted as the two actually agreeing,
    // not as two expectations that happen to match.
    const contents = [1, 2, 3].map((i) => runLine(`run-${i}`)).join("\n") + "\n";
    const file = tmpFile("q.jsonl", contents);
    const json = await runCli(["--json", "--lines", "2-6,99", file], srv.url);
    const plain = await runCli(["--lines", "2-6,99", file], srv.url);
    const doc = parseDocument(json.stdout);
    assert.deepEqual((doc.summary as Record<string, unknown>).absent, ["4-6", "99"]);
    assert.match(plain.stdout, /--lines named 4-6, 99, which the file does not have/);
    rm(file);
  } finally {
    await srv.close();
  }
});

test("SPGD-1358: --from-line keeps its held-back wording and gains no absent clause, past-EOF included", async () => {
  const contents = [1, 2].map((i) => runLine(`run-${i}`)).join("\n") + "\n";
  const file = tmpFile("q.jsonl", contents);
  try {
    // Past the end of the file: the suffix already says so through the lines
    // it held back — widening the clause here would restate one fact as two.
    const past = await runCli(["--list", "--from-line", "9", file]);
    assert.equal(past.code, 0);
    assert.match(past.stderr, /holds no runs to list \(2 earlier lines skipped by --from-line\)\n$/);
    assert.ok(!past.stderr.includes("the file does not have"));

    // In range: no clause either.
    const inside = await runCli(["--list", "--from-line", "2", file]);
    assert.equal(inside.code, 0);
    assert.match(inside.stdout, /1 earlier line skipped by --from-line/);
    assert.ok(!inside.stdout.includes("the file does not have"));

    // The document agrees: `absent` is null under --from-line at every value.
    const pastJson = await runCli(["--list", "--json", "--from-line", "9", file]);
    const doc = parseDocument(pastJson.stdout);
    assert.equal((doc.summary as Record<string, unknown>).absent, null);
    assert.equal((doc.summary as Record<string, unknown>).selector, "--from-line");
    rm(file);
  } finally {
    rm(file);
  }
});

test("SPGD-1358: a named line that exists and is blank reports as blank only, never also as absent", async () => {
  const file = tmpFile("gappy.jsonl", `${runLine("1")}\n\n${runLine("3")}\n`);
  try {
    const r = await runCli(["--list", "--lines", "2", file]);
    assert.equal(r.code, 0);
    // Lines 1 and 3 were held back by --lines and the named line 2 was blank:
    // each cause stated, and no absent clause — the blank owns its line.
    assert.match(r.stderr, /holds no runs to list \(1 blank line skipped; 2 lines not selected by --lines\)\n$/);
    assert.ok(!r.stderr.includes("the file does not have"));

    const json = await runCli(["--list", "--json", "--lines", "2", file]);
    const doc = parseDocument(json.stdout);
    const summary = doc.summary as Record<string, unknown>;
    assert.equal(summary.blank, 1);
    assert.equal(summary.absent, null, "never [] and never a second cause for the blank");
    rm(file);
  } finally {
    rm(file);
  }
});

test("SPGD-1358: blank, held-back and absent are stated together, each cause exactly once", async () => {
  const file = tmpFile("gappy.jsonl", `${runLine("1")}\n\n${runLine("3")}\n`);
  try {
    const r = await runCli(["--list", "--lines", "1-2,9", file]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /1 blank line skipped/);
    assert.match(r.stdout, /1 line not selected by --lines/);
    assert.match(r.stdout, /--lines named 9, which the file does not have/);
    // Additive, not redundant: every cause stated once, none dropped in favour
    // of another.
    assert.equal(r.stdout.split("the file does not have").length - 1, 1);
    assert.equal(r.stdout.split("blank line").length - 1, 1);

    const json = await runCli(["--list", "--json", "--lines", "1-2,9", file]);
    const doc = parseDocument(json.stdout);
    assert.deepEqual(doc.summary, {
      lines: 1,
      attempted: 0,
      accepted: 0,
      refused: 0,
      undelivered: 0,
      unparseable: 0,
      blank: 1,
      skipped: 1,
      absent: ["9"],
      selector: "--lines",
    });
    rm(file);
  } finally {
    rm(file);
  }
});

test("SPGD-1358: a wholly-unmatched selector's warning states its own cause, distinct from the empty-file warning", async () => {
  const file = tmpFile("q.jsonl", `${runLine("1")}\n${runLine("2")}\n`);
  const empty = tmpFile("e.jsonl", "");
  try {
    // A typo'd range and a genuinely empty file are different mistakes, and
    // only one of them is the user's — the absent clause is what tells them
    // apart. Exit stays 0 on both: a short selection is not a verdict.
    const typo = await runCli(["--list", "--lines", "40-50", file]);
    assert.equal(typo.code, 0);
    assert.equal(typo.stdout, "");
    assert.match(
      typo.stderr,
      /holds no runs to list \(2 lines not selected by --lines; --lines named 40-50, which the file does not have\)/,
    );

    const emptyRun = await runCli(["--list", empty]);
    assert.equal(emptyRun.code, 0);
    assert.equal(emptyRun.stderr, `specguard-ingest: warning: ${empty} holds no runs to list\n`);
    assert.notEqual(typo.stderr, emptyRun.stderr);
  } finally {
    rm(file);
    rm(empty);
  }
});

test("SPGD-1358: a repeated absent number is named once", async () => {
  // Four lines so something is listed — a wholly-empty listing prints no text
  // summary, and the dedupe has to be visible on the text channel too.
  const contents = [1, 2, 3, 4].map((i) => runLine(`run-${i}`)).join("\n") + "\n";
  const file = tmpFile("q.jsonl", contents);
  try {
    const r = await runCli(["--list", "--lines", "3,5,5,7-9", file]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /--lines named 5, 7-9, which the file does not have/);
    assert.equal(r.stdout.split("the file does not have").length - 1, 1);

    const json = await runCli(["--list", "--json", "--lines", "3,5,5,7-9", file]);
    const doc = parseDocument(json.stdout);
    assert.deepEqual((doc.summary as Record<string, unknown>).absent, ["5", "7-9"]);
    rm(file);
  } finally {
    rm(file);
  }
});

test("SPGD-1358: delivery mode — the delivered set is unchanged by the absent naming (distinct-identity sink)", async () => {
  // The outcome check an endpoint-free battery cannot produce: every line a
  // distinct identity, so the received-body log names the selection directly.
  // The mutation must be reporting-only — the same bodies arrive with
  // `--lines 3,99` as with `--lines 3`.
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"tr_1"}' });
  try {
    const contents = [1, 2, 3, 4, 5].map((i) => runLine(`run-${i}`)).join("\n") + "\n";
    const file = tmpFile("q.jsonl", contents);
    const satisfied = await runCli(["--lines", "3", file], srv.url);
    const satisfiedBodies = srv.bodies.slice();
    assert.deepEqual(
      satisfiedBodies.map((b) => /run-(\d)/.exec(b)?.[1]),
      ["3"],
    );
    srv.bodies.length = 0;

    const phantom = await runCli(["--lines", "3,99", file], srv.url);
    assert.equal(phantom.code, 0);
    assert.deepEqual(srv.bodies, satisfiedBodies, "identical bodies, phantom entry or not");
    assert.match(phantom.stdout, /--lines named 99, which the file does not have/);
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

// NEGATIVE-FIRST for SPGD-1442: the clauses this example asserts did not exist
// before the fix — measured at f74c6a8, `test_results.local` had zero hits in
// the help text, so every assertion here fails on the pre-fix text while every
// existing help pin already passes there. The fourth assertion is a guard, not
// a new clause: the EVERY-line hazard must survive the rewrite in full.
test("SPGD-1442: --help names both sinks — the replay queue and the keyless local development record", async () => {
  const r = await runCli(["--help"]);
  assert.equal(r.code, 0);
  const screen = r.stdout.replace(/\s+/g, " ");
  assert.match(screen, /the replay queue, log\/test_results\.jsonl/);
  assert.match(screen, /the local development record, log\/test_results\.local\.jsonl/);
  assert.match(screen, /when no API key is configured/);
  assert.match(screen, /EVERY line in <file> is delivered/);
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
      absent: null,
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
      absent: null,
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
      absent: null,
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
      absent: null,
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

// ---------------------------------------------------------------------------
// SPGD-1462: `--drain` — the follow-through. A successful replay used to leave
// the queue byte-identical: the next incident's failures appended behind runs
// that had already landed, and the README's retry gesture — re-running the
// command — re-sent every one of them. `--drain` removes, atomically, exactly
// the lines the endpoint accepted IN THIS INVOCATION; everything else stays
// byte for byte, in the file's order. Port of the Ruby twin's
// `--drain, emptying the queue as it is accepted` block (SPGD-1450/1455/1456,
// landed at specguard-rspec 269f8ef), mirrored example for example where the
// runtime allows: the Ruby spec patches `File.rename`; ESM imports cannot be
// patched, so the same failure injection runs through a `drainFs` seam on
// `IngestRunOptions` — the same trade `fetchImpl` already makes for delivery.

/** A refusal (a 400 is the one permanent content verdict) and an outage, shaped like the Ruby block's. */
const refusalVerdict = { status: 400, body: '{"message":"spec 1: outcome is required"}' };
const outageVerdict = { status: 503, body: "upstream is down" };

/** The drain empties the CONFIGURED queue and nothing else — a temp file is not the queue until this names it. */
function queueOverrides(file: string): Record<string, string> {
  return { SPECGUARD_OUTPUT_PATH: file };
}

/** The real filesystem, with one replaceable member — the base every drainFs spy builds on. */
function realDrainFs(overrides: Partial<DrainFs>): DrainFs {
  return { realpath, writeFile, stat, chmod, rename, unlink, ...overrides };
}

test("SPGD-1462: empties a queue whose lines were all accepted, and a second --drain sends nothing", async () => {
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"tr_1"}' });
  try {
    const file = tmpFile("q.jsonl", `${runLine("a")}\n${runLine("b")}\n`);
    const r = await runCli(["--drain", file], srv.url, queueOverrides(file));
    assert.equal(r.code, 0);
    assert.equal(srv.bodies.length, 2);
    assert.equal(readFileSync(file).length, 0, "an all-accepted queue is 0 bytes after --drain");
    assert.ok(r.stdout.includes(`; 2 accepted lines removed from ${file}`));

    // The second run — the one the README calls the retry — POSTs nothing over
    // the empty file, warns exactly as it always has, and still exits 0.
    const r2 = await runCli(["--drain", file], srv.url, queueOverrides(file));
    assert.equal(r2.code, 0);
    assert.equal(srv.bodies.length, 2, "the second --drain POSTs nothing");
    assert.equal(r2.stderr, `specguard-ingest: warning: ${file} holds no runs to deliver\n`);
    assert.equal(r2.stdout, "");
    assert.equal(readFileSync(file).length, 0);
    rm(file);
  } finally {
    await srv.close();
  }
});

test("SPGD-1462: keeps exactly the non-accepted lines of a mixed file, byte for byte, in order", async () => {
  const srv = await captureServer(
    { status: 202, body: '{"test_run_id":"tr_1"}' },
    [
      { status: 202, body: '{"test_run_id":"tr_1"}' },
      refusalVerdict,
      outageVerdict,
    ],
  );
  try {
    // Six statuses in one file, as AC2 names them: one accepted line, a blank,
    // a 400, a 503, an unparseable line, and one that is not valid UTF-8.
    const invalidUtf8 = Buffer.from([0xff, 0xfe]);
    const contents = Buffer.concat([
      Buffer.from(`${runLine("ok")}\n\n${runLine("refused")}\n${runLine("down")}\n{not json\n`),
      invalidUtf8,
      Buffer.from("\n"),
    ]);
    const file = tmpFile("mixed.jsonl", contents);
    const kept = Buffer.concat([
      Buffer.from(`\n${runLine("refused")}\n${runLine("down")}\n{not json\n`),
      invalidUtf8,
      Buffer.from("\n"),
    ]);

    const r = await runCli(["--drain", file], srv.url, queueOverrides(file));
    // 2 dominates: the refused line and the undelivered one are both still in
    // the file, and the exit code shouts the one that leaves work undone.
    assert.equal(r.code, 2);
    assert.equal(srv.bodies.length, 3, "blank, unparseable and non-UTF-8 lines are never POSTed");
    assert.ok(readFileSync(file).equals(kept));
    assert.ok(r.stdout.includes(`delivered 1 of 5 runs from ${file}`));
    assert.ok(
      r.stdout.includes(
        `; 1 accepted line removed from ${file} — the 5 lines left are now numbered from 1, ` +
          `so the numbers above no longer address them`,
      ),
    );
    rm(file);
  } finally {
    await srv.close();
  }
});

test("SPGD-1462: says the reported numbers are pre-drain when the drain leaves lines behind", async () => {
  const srv = await captureServer(
    { status: 202, body: '{"test_run_id":"tr_1"}' },
    [
      { status: 202, body: '{"test_run_id":"tr_1"}' },
      outageVerdict,
      { status: 202, body: '{"test_run_id":"tr_1"}' },
    ],
  );
  try {
    const file = tmpFile("three.jsonl", `${runLine("a")}\n${runLine("b")}\n${runLine("c")}\n`);
    const r = await runCli(["--drain", file], srv.url, queueOverrides(file));
    // The undelivered line is still in the file, and the exit code shouts the
    // one that leaves work undone. The full pin is deliberate: it shows the
    // very mismatch the clause is about — the report's "line 2" against a
    // rewritten file whose only line is the undelivered one.
    assert.equal(r.code, 2);
    assert.equal(srv.bodies.length, 3);
    assert.equal(readFileSync(file, "utf8"), `${runLine("b")}\n`);
    assert.equal(
      r.stdout,
      `line 1: accepted — HTTP 202, test_run_id tr_1, ci_run_id a\n` +
        `line 2: not delivered — HTTP 503 — upstream is down\n` +
        `line 3: accepted — HTTP 202, test_run_id tr_1, ci_run_id c\n` +
        `specguard-ingest: delivered 2 of 3 runs from ${file}; 1 could not be delivered; ` +
        `2 accepted lines removed from ${file} — the 1 line left is now numbered from 1, ` +
        `so the numbers above no longer address it\n`,
    );
    rm(file);
  } finally {
    await srv.close();
  }
});

test("SPGD-1462: stays silent about renumbering when nothing was accepted and when the file was emptied", async () => {
  const srv = await captureServer(
    { status: 202, body: '{"test_run_id":"tr_1"}' },
    [refusalVerdict, { status: 202, body: '{"test_run_id":"tr_1"}' }],
  );
  try {
    const refusedOnly = tmpFile("refused.jsonl", `${runLine("r")}\n`);
    const r1 = await runCli(["--drain", refusedOnly], srv.url, queueOverrides(refusedOnly));
    assert.equal(r1.code, 1);
    assert.ok(r1.stdout.includes(`delivered 0 of 1 run from ${refusedOnly}`));
    assert.ok(!r1.stdout.includes("accepted line"), "nothing removed, so no drain clause");
    assert.equal(readFileSync(refusedOnly, "utf8"), `${runLine("r")}\n`, "no rewrite, file untouched");
    rm(refusedOnly);

    const emptied = tmpFile("emptied.jsonl", `${runLine("a")}\n${runLine("b")}\n`);
    const r2 = await runCli(["--drain", emptied], srv.url, queueOverrides(emptied));
    assert.equal(r2.code, 0);
    assert.ok(r2.stdout.endsWith(`; 2 accepted lines removed from ${emptied}\n`));
    assert.ok(!r2.stdout.includes("now numbered from 1"), "no line left for the sentence to be about");
    rm(emptied);
  } finally {
    await srv.close();
  }
});

test("SPGD-1462: removes at most the lines --lines named, holding every other one", async () => {
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"tr_1"}' });
  try {
    const file = tmpFile("three.jsonl", `${runLine("a")}\n${runLine("b")}\n${runLine("c")}\n`);
    const r = await runCli(["--drain", "--lines", "2", file], srv.url, queueOverrides(file));
    assert.equal(r.code, 0);
    assert.deepEqual(
      srv.bodies.map((b) => /"ci_run_id":"([^"]*)"/.exec(b)?.[1]),
      ["b"],
    );
    assert.equal(readFileSync(file, "utf8"), `${runLine("a")}\n${runLine("c")}\n`);
    assert.ok(
      r.stdout.includes(
        `; 1 accepted line removed from ${file} — the 2 lines left are now numbered from 1, ` +
          `so the numbers above no longer address them`,
      ),
    );
    rm(file);
  } finally {
    await srv.close();
  }
});

test("SPGD-1462: removes the accepted suffix under --from-line, keeping the skipped prefix", async () => {
  const srv = await captureServer(
    { status: 202, body: '{"test_run_id":"tr_1"}' },
    [
      { status: 202, body: '{"test_run_id":"tr_1"}' },
      refusalVerdict,
    ],
  );
  try {
    const file = tmpFile("three.jsonl", `${runLine("a")}\n${runLine("b")}\n${runLine("c")}\n`);
    const r = await runCli(["--drain", "--from-line", "2", file], srv.url, queueOverrides(file));
    assert.equal(r.code, 1);
    assert.deepEqual(
      srv.bodies.map((b) => /"ci_run_id":"([^"]*)"/.exec(b)?.[1]),
      ["b", "c"],
    );
    assert.equal(readFileSync(file, "utf8"), `${runLine("a")}\n${runLine("c")}\n`);
    assert.ok(
      r.stdout.includes(
        `; 1 accepted line removed from ${file} — the 2 lines left are now numbered from 1, ` +
          `so the numbers above no longer address them`,
      ),
    );
    rm(file);
  } finally {
    await srv.close();
  }
});

test("SPGD-1462: carries a line appended while the deliveries ran into the rewrite", async () => {
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"tr_1"}' });
  try {
    const file = tmpFile("q.jsonl", `${runLine("a")}\n${runLine("b")}\n`);
    const appended = `${runLine("appended")}\n`;
    // The reporter appends to the queue with no lock; driven from the delivery
    // seam, this lands after the first POST — `readSource` is behind it, the
    // rewrite is ahead of it: the window the tail-carry exists for. Dropping
    // the tail-carry fails this example, and so does a naive
    // `writeFile(path, kept)`: both throw the appended line away.
    const realFetch = globalThis.fetch;
    let posts = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const res = await realFetch(input, init);
      posts += 1;
      if (posts === 1) appendFileSync(file, appended);
      return res;
    };
    const o = out();
    const e = out();
    const code = await run(["--drain", file], o.stream, e.stream, {
      env: envFor(srv.url, queueOverrides(file)),
      fetchImpl,
    });
    assert.equal(code, 0);
    assert.equal(srv.bodies.length, 2, "the appended line is carried, never delivered");
    assert.equal(readFileSync(file, "utf8"), appended);
    rm(file);
  } finally {
    await srv.close();
  }
});

test("SPGD-1462: refuses to combine with --list, leaving the file untouched", async () => {
  const file = tmpFile("q.jsonl", `${runLine("a")}\n`);
  try {
    const before = readFileSync(file);
    const r = await runCli(["--drain", "--list", file]);
    assert.equal(r.code, 2);
    assert.equal(
      r.stderr,
      "specguard-ingest: error: --drain delivers and removes the lines that were accepted; " +
        "--list delivers nothing, so there is nothing for it to drain\n",
    );
    assert.ok(readFileSync(file).equals(before), "a refusal that moved the file would not be a refusal");
    rm(file);
  } finally {
    // nothing to close
  }
});

test("SPGD-1462: --drain takes no value — the attached form is an invalid option, like --list and --json", async () => {
  const file = tmpFile("q.jsonl", `${runLine("a")}\n`);
  try {
    const r = await runCli(["--drain=1", file]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /invalid option: --drain=1/);
    rm(file);
  } finally {
    // nothing to close
  }
});

test("SPGD-1462: refuses to drain a path that is not the configured replay queue", async () => {
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"tr_1"}' });
  try {
    const file = tmpFile("q.jsonl", `${runLine("a")}\n`);
    const before = readFileSync(file);
    // No SPECGUARD_OUTPUT_PATH: the temp file is not the configured queue,
    // which is exactly the situation the guard exists for. Nothing is
    // delivered either — the refusal fires before the transport does.
    const r = await runCli(["--drain", file], srv.url);
    assert.equal(r.code, 2);
    assert.equal(srv.bodies.length, 0);
    assert.ok(r.stderr.includes(`--drain empties the replay queue, and ${file} is not it`));
    assert.ok(r.stderr.includes("(configured as log/test_results.jsonl)"));
    assert.ok(r.stderr.includes("the local record is a development record, not a queue"));
    assert.ok(readFileSync(file).equals(before));
    rm(file);
  } finally {
    await srv.close();
  }
});

test("SPGD-1462: drains a file spelled exactly as SPECGUARD_OUTPUT_PATH configures the queue", async () => {
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"tr_1"}' });
  try {
    const file = tmpFile("q.jsonl", `${runLine("a")}\n`);
    const r = await runCli(["--drain", file], srv.url, queueOverrides(file));
    assert.equal(r.code, 0);
    assert.equal(srv.bodies.length, 1);
    assert.equal(readFileSync(file).length, 0);
    rm(file);
  } finally {
    await srv.close();
  }
});

test("SPGD-1462: swaps the rewrite in through a same-directory rename, original intact until the swap", async () => {
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"tr_1"}' });
  try {
    const file = tmpFile("q.jsonl", `${runLine("a")}\n${runLine("b")}\n`);
    const original = readFileSync(file);
    const observed: Record<string, boolean> = {};
    const realRename = rename;
    const drainFs: DrainFs = realDrainFs({
      rename: async (from, to) => {
        const fromPath = from.toString();
        const toPath = to.toString();
        observed.sameDir = dirname(fromPath) === dirname(toPath);
        observed.distinctName = basename(fromPath) !== basename(toPath);
        observed.originalIntact = readFileSync(toPath).equals(original);
        await realRename(from, to);
      },
    });
    const o = out();
    const e = out();
    const code = await run(["--drain", file], o.stream, e.stream, {
      env: envFor(srv.url, queueOverrides(file)),
      drainFs,
    });
    assert.equal(code, 0);
    // An in-place `writeFile(path, kept)` never calls rename, so it fails here
    // — and at the failure-injection example below.
    assert.deepEqual(observed, { sameDir: true, distinctName: true, originalIntact: true });
    assert.equal(readFileSync(file).length, 0);
    rm(file);
  } finally {
    await srv.close();
  }
});

test("SPGD-1462: leaves the file byte-identical and exits 2 when the rename fails", async () => {
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"tr_1"}' });
  try {
    const file = tmpFile("q.jsonl", `${runLine("a")}\n${runLine("b")}\n`);
    const original = readFileSync(file);
    const drainFs: DrainFs = realDrainFs({
      rename: async () => {
        throw Object.assign(new Error("input/output error"), { code: "EIO" });
      },
    });
    const o = out();
    const e = out();
    const code = await run(["--drain", file], o.stream, e.stream, {
      env: envFor(srv.url, queueOverrides(file)),
      drainFs,
    });
    // A failure mid-drain leaves the original intact — the whole point of the
    // temp file — leaves no stray temporary behind, and is stated, never
    // silent: the deliveries are still reported in full, the warning names the
    // file, and the run exits 2, because a 0 would read as "drained" about a
    // queue that was not.
    assert.equal(code, 2);
    assert.ok(readFileSync(file).equals(original));
    assert.deepEqual(readdirSync(dirname(file)), [basename(file)]);
    assert.ok(e.text().includes(`could not remove the accepted lines from ${file}`));
    assert.ok(e.text().includes("the file is left as it was"));
    assert.ok(o.text().includes("line 1: accepted"));
    assert.ok(!o.text().includes("accepted lines removed"));
    rm(file);
  } finally {
    await srv.close();
  }
});

test("SPGD-1462: keeps the queue file's mode through the atomic swap", async () => {
  const srv = await captureServer(
    { status: 202, body: '{"test_run_id":"tr_1"}' },
    [
      { status: 202, body: '{"test_run_id":"tr_1"}' },
      refusalVerdict,
      outageVerdict,
    ],
  );
  try {
    // 0o640 rather than 0o600 so the example cannot pass by accident: 0600 is
    // exactly the default under umask 077, where this would pass without the fix.
    const file = tmpFile("mixed.jsonl", `${runLine("ok")}\n${runLine("refused")}\n${runLine("down")}\n`);
    chmodSync(file, 0o640);
    const r = await runCli(["--drain", file], srv.url, queueOverrides(file));
    assert.equal(r.code, 2);
    assert.equal(statSync(file).mode & 0o7777, 0o640, "the rewrite must not reset the file's mode");
    assert.equal(readFileSync(file, "utf8"), `${runLine("refused")}\n${runLine("down")}\n`);
    rm(file);
  } finally {
    await srv.close();
  }
});

test("SPGD-1462: rewrites a symlinked queue's target, leaving the link itself in place", async () => {
  const srv = await captureServer(
    { status: 202, body: '{"test_run_id":"tr_1"}' },
    [
      { status: 202, body: '{"test_run_id":"tr_1"}' },
      refusalVerdict,
      outageVerdict,
    ],
  );
  try {
    // `rename(2)` replaces the directory entry at the path it is given, so on
    // a queue reached through a symlink the naive swap would replace the link
    // itself with a regular file — and leave the real target holding every
    // line just accepted, which the next drain would then send again.
    const dir = mkdtempSync(join(tmpdir(), "specguard-ingest-link-"));
    const target = join(dir, "target.jsonl");
    const link = join(dir, "queue-link.jsonl");
    writeFileSync(target, `${runLine("ok")}\n${runLine("refused")}\n${runLine("down")}\n`);
    symlinkSync(target, link);

    const r = await runCli(["--drain", link], srv.url, queueOverrides(link));
    assert.equal(r.code, 2);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(readlinkSync(link), target);
    assert.equal(readFileSync(target, "utf8"), `${runLine("refused")}\n${runLine("down")}\n`);
    rmSync(dir, { recursive: true, force: true });
  } finally {
    await srv.close();
  }
});

test("SPGD-1462: states the removal in the --json summary, and only under the flag", async () => {
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"tr_1"}' });
  try {
    const file = tmpFile("q.jsonl", `${runLine("a")}\n${runLine("b")}\n`);
    const drained = await runCli(["--json", "--drain", file], srv.url, queueOverrides(file));
    assert.equal(drained.code, 0);
    assert.equal(JSON.parse(drained.stdout).summary.drained, 2);
    assert.equal(readFileSync(file).length, 0);

    writeFileSync(file, `${runLine("a")}\n${runLine("b")}\n`);
    const plain = await runCli(["--json", file], srv.url, queueOverrides(file));
    assert.equal(plain.code, 0);
    assert.equal("drained" in JSON.parse(plain.stdout).summary, false, "absent without the flag");
    rm(file);
  } finally {
    await srv.close();
  }
});

test("SPGD-1462: names the removal in the summary line, and only when the flag asked for it", async () => {
  const srv = await captureServer({ status: 202, body: '{"test_run_id":"tr_1"}' });
  try {
    const file = tmpFile("q.jsonl", `${runLine("a")}\n${runLine("b")}\n`);
    const drained = await runCli(["--drain", file], srv.url, queueOverrides(file));
    assert.equal(drained.code, 0);
    assert.ok(
      drained.stdout.includes(`delivered 2 of 2 runs from ${file}; 2 accepted lines removed from ${file}`),
    );

    // The whole default non-interference pin: same fixture, no flag, and the
    // stdout is the pre-drain bytes exactly and the file does not move.
    writeFileSync(file, `${runLine("a")}\n${runLine("b")}\n`);
    const before = readFileSync(file);
    const plain = await runCli([file], srv.url, queueOverrides(file));
    assert.equal(plain.code, 0);
    assert.equal(
      plain.stdout,
      `line 1: accepted — HTTP 202, test_run_id tr_1, ci_run_id a\n` +
        `line 2: accepted — HTTP 202, test_run_id tr_1, ci_run_id b\n` +
        `specguard-ingest: delivered 2 of 2 runs from ${file}\n`,
    );
    assert.ok(readFileSync(file).equals(before));
    rm(file);
  } finally {
    await srv.close();
  }
});

test("SPGD-1462: documents --drain in the help, beside the selectors it composes with", async () => {
  const r = await runCli(["--help"]);
  assert.equal(r.code, 0);
  const screen = r.stdout.replace(/\s+/g, " ");
  assert.ok(screen.includes("--drain is the follow-through, and it is opt-in"));
  assert.ok(
    screen.includes(
      "refused, undelivered, unparseable and blank lines, and every line --from-line or --lines held back",
    ),
  );
  assert.ok(screen.includes("a rewrite that could not complete is a 2 as well — the file is left as it was"));
  assert.ok(screen.includes("After delivering, remove from <file> exactly the lines this run accepted"));
  assert.match(r.stdout, /Usage: specguard-ingest \[--list\] \[--from-line N \| --lines SPEC\] <file> \[--drain\]/);
});

test("SPGD-1462: keeps the numbering guarantee scoped in the README and the help", async () => {
  // The renumbering guarantee has to stay SCOPED. The README once said "the
  // numbering never shifts" with no qualifier — false the day --drain landed,
  // since its rewrite packs the surviving lines up from the top and a report
  // whose numbers the next command cannot use is exactly the failure a
  // per-line report exists to prevent. The compiled test runs from
  // .test-build/test/, so the package root is two levels up.
  const readme = readFileSync(join(here, "..", "..", "README.md"), "utf8");  assert.ok(
    !readme.includes("the numbering never shifts:"),
    "the unconditional never-shifts claim is back in README.md — it is false on the --drain path, " +
      "whose rewrite renumbers the surviving lines",
  );
  assert.ok(
    readme.includes("the numbering never shifts between invocations that do not drain"),
    "the scoped never-shifts claim is gone from README.md",
  );
  assert.ok(readme.includes("The removal renumbers what it leaves"));
  assert.ok(
    readme.replace(/\s+/g, " ").includes("re-run `--list` to see the renumbered file, or run `--drain` again"),
    "the README's resume guidance for a drained queue is gone",
  );
  assert.ok(readme.includes("each `lines[].number` refers to the file **before** the drain"));

  const help = await runCli(["--help"]);
  const screen = help.stdout.replace(/\s+/g, " ");
  assert.ok(screen.includes("Removing lines renumbers what is left"));
  assert.ok(screen.includes("describe <file> as it was read, not as the next run finds it"));
  assert.ok(screen.includes("resume by re-running --list (or --drain) rather than reusing those numbers"));
});
