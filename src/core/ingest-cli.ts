import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { readRunnerEnv, type RunnerEnv } from "./env.js";
import { deliverRawLine, version } from "./transport.js";
import { renderDelivery, renderListing } from "./ingest-reporter.js";

/**
 * `specguard-ingest`'s command line — the other end of the replay queue.
 *
 * The reporters append every undelivered run to `log/test_results.jsonl`, one
 * whole run per line, byte-for-byte the body the endpoint was offered. This
 * is the command that sends it: fix the rotated key, then replay the run the
 * suite already finished, instead of re-running the suite.
 *
 * Mirrors `SpecGuard::RSpec::IngestCLI` (the Ruby client's bin), same exit
 * contract as `specguard lint`:
 *
 *   0  every line was accepted (or the file was listed)
 *   1  at least one line was REFUSED BY THE ENDPOINT as content — HTTP 400
 *      only, the one response the platform forms an opinion about a payload in
 *   2  this tool could not do its job — bad flags, no endpoint/key, an
 *      unreadable file, an unparseable line, 401/404/429/5xx, a delivery that
 *      never reached the endpoint (no verdict about the run exists in any of
 *      them)
 *
 * 2 dominates: a file where line 3 was refused and line 7 never arrived exits
 * 2, because the second fact is the one that leaves work undone. Both are
 * printed either way — the exit code chooses what to shout, never what to say.
 *
 * `run` RETURNS a code and never throws; a bug in this tool is a 2 with one
 * stderr line, not a stack trace. (The never-fail constraint on the REPORTERS
 * is about the test run; this bin is out of band and its exit code is its
 * product, which is why failures are spoken here rather than swallowed.)
 */

/** Every line accepted — including the vacuous empty file, which is loud on stderr. */
export const EXIT_OK = 0;
/** ≥1 line refused by the endpoint as content (HTTP 400 only). */
export const EXIT_REFUSED = 1;
/** This tool could not do its job. */
export const EXIT_MISUSE = 2;

/**
 * The status codes that carry a verdict about the payload. A 401 is answered
 * by auth before the payload is read, a 404/429/5xx never judges the run —
 * they are "not delivered" (2), never "refused" (1). A list of one so a
 * platform that grows a second verdict is a one-line change; under-claiming
 * sends an operator to look at their setup, not at a suite never judged.
 */
const CONTENT_REFUSAL_CODES: readonly number[] = [400];

const BANNER = "Usage: specguard-ingest [--list] [--from-line N | --lines SPEC] <file>";

/** One entry of a `--lines` spec: `12` or `12-15`, and nothing else. */
const LINE_SPEC_ENTRY = /^(\d+)(?:-(\d+))?$/;

/** `--lines` stays a list of ranges, never an expanded set — `1-90000000` costs nothing to hold. */
interface LineRange {
  first: number;
  last: number;
}

type LineStatus = "accepted" | "refused" | "undelivered" | "unparseable";

const STATUS_LABELS: Record<LineStatus, string> = {
  accepted: "accepted",
  refused: "refused",
  undelivered: "not delivered",
  unparseable: "unparseable",
};

export interface LineResult {
  /** 1-based position in the file as given, blanks counted — the number an editor shows. */
  number: number;
  status: LineStatus;
  detail: string;
  /**
   * The endpoint's HTTP status, `null` where there is not one: a line that
   * was never a run, and a delivery that never got an answer at all.
   * Together with `status` it tells those two apart from a refusal, which is
   * why `reasons` can collapse all three into one list.
   */
  code: number | null;
  /**
   * Why the line did not land, AS IT ARRIVED: the platform's per-spec strings
   * on a refusal — the whole array, uncapped, not the three the `detail` line
   * has room for — the parse problem where the line was never a run, the
   * error's rendering where nothing reached the endpoint, and `[]` on an
   * acceptance. `null` where a refusal's body said nothing readable.
   * Normalising this to an always-a-list-of-strings is the REPORTER's job,
   * because that guarantee is the document's rather than this struct's —
   * exactly the split the Ruby twin draws (`IngestCLI::LineResult` vs
   * `IngestReporter.reasons`).
   */
  reasons: string[] | null;
  /** The endpoint's run id, on an acceptance. */
  testRunId: string | null;
  /** The line's own ci_run_id, when it carried one — the folding key. */
  ciRunId: string | null;
}

/** Two or more accepted lines that went out with one ci_run_id and came back with one test_run_id — folding, observed rather than inferred. */
export interface Folding {
  ciRunId: string;
  testRunId: string;
  numbers: number[];
}

/** The four status counts, computed once per run and handed to whichever renderer runs. */
export interface StatusCounts {
  accepted: number;
  refused: number;
  undelivered: number;
  unparseable: number;
}

export interface ListedLine {
  number: number;
  /** Why the line is not a run; null for every line that is one. */
  problem: string | null;
  branch: string | null;
  commitSha: string | null;
  ciRunId: string | null;
  examples: number | null;
  durationSeconds: number | null;
}

export interface Options {
  path: string;
  fromLine: number;
  list: boolean;
  lineSet: LineRange[] | null;
  /** Chooses the renderer, never the set that is listed or sent and never the code that is returned. */
  json: boolean;
  /** Set by `-v`/`--version`: the identity query short-circuits the run. */
  version: boolean;
}

/**
 * The file, as this tool reads it: payloads held, blanks counted, held-backs counted and named.
 *
 * `absent` is the same discipline applied one layer later, to the lines that
 * were *typed* rather than to the lines that were read. A `--lines` entry can
 * name a line past the end of the file, and such a number is not held back —
 * there was nothing there to hold — so `skipped` cannot carry it and the
 * file's own counts cannot state it. It is derived from the file's length in
 * {@link readSource} and rendered in the shorthand it was typed in, because
 * the user acts on what they typed. Empty when the selector was fully
 * satisfied, and empty under `--from-line`, whose past-the-end case is already
 * a suffix that selected nothing. Computed once here and rendered by BOTH
 * renderers — two renderers of one reading that can disagree are worse than
 * prose alone.
 */
export interface Source {
  path: string;
  /** `text` is null for a line that is not valid UTF-8 — a verdict/row, never a delivery. */
  lines: { number: number; text: string | null }[];
  blank: number;
  skipped: number;
  /** The `--lines` numbers the file does not have, each a number or an `N-M` range, in the shorthand typed. */
  absent: string[];
  selector: "from-line" | "lines";
}

class UsageError extends Error {}

export interface IngestStream {
  write(text: string): unknown;
}

export interface IngestRunOptions {
  /** Overrides the process environment (tests). */
  env?: Record<string, string | undefined>;
  /** Transport injection (tests). */
  fetchImpl?: typeof fetch;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** A free-form field the envelope may carry; anything non-scalar is "not said", never invented. */
function scalar(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

function typeName(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (value === null) return "null";
  return `a ${typeof value}`;
}

/**
 * `[payload, null]` or `[null, problem]`. Parsing is used ONLY for display
 * metadata (`--list` rows, the ci_run_id a verdict reports, the unparseable
 * verdict itself) — NEVER to build the POST body, which is the line's own
 * bytes. Node's `JSON.parse` accepts what the protocol rejects (a lone
 * `\ud800` escape parses fine and repairs to U+FFFD on re-encode), so a
 * parse result must never sit between the file and the wire; such a line is
 * delivered as written and the endpoint renders its own verdict about it.
 */
function parsePayload(
  text: string,
): { payload: Record<string, unknown> } | { problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const first = message.split("\n")[0] ?? message;
    return { problem: `could not parse the line as JSON: ${first.trim()}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { problem: `the line is ${typeName(parsed)} JSON, and a run is an object` };
  }
  return { payload: parsed as Record<string, unknown> };
}

function decodeUtf8Strict(buf: Buffer): string | null {
  try {
    // ignoreBOM keeps a leading byte-order mark in the decoded text, so the
    // re-encoded POST body is the line's own bytes even there — a decoder
    // that silently stripped it would rewrite the file's bytes on the wire.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    return null;
  }
}

/**
 * Read the file as bytes and cut it on `\n`. Byte-level splitting is what
 * keeps replay byte-for-byte: reading through a lossy text decoding would
 * repair invalid UTF-8 into U+FFFD *in the file's own bytes* before anything
 * else happened. A line that is not valid UTF-8 stays a line — it becomes an
 * unparseable verdict (delivery) or a row (listing) rather than an exception,
 * so one corrupt line cannot stop the other thirty-nine from delivering.
 */
async function readSource(options: Options, procEnv: Record<string, string | undefined>): Promise<Source> {
  const path = options.path;
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new UsageError(noSuchFileMessage(path, procEnv));
    if (code === "EISDIR") throw new UsageError(`not a file: ${path}`);
    throw new UsageError(
      `could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const lines: { number: number; text: string | null }[] = [];
  let blank = 0;
  let skipped = 0;

  let start = 0;
  let number = 0;
  const consider = (chunk: Buffer, isLast: boolean): void => {
    if (isLast && chunk.length === 0) return; // the file's final `\n`, not a line
    number += 1;
    if (heldBack(number, options)) {
      skipped += 1;
      return;
    }
    const text = decodeUtf8Strict(chunk);
    if (text === null) {
      // Not valid UTF-8 — not blank, not deliverable; kept (text null) so the
      // verdict can name it and the rest of the file still delivers.
      lines.push({ number, text: null });
      return;
    }
    if (text.trim() === "") {
      blank += 1;
      return;
    }
    lines.push({ number, text });
  };
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === 0x0a) {
      consider(raw.subarray(start, i), false);
      start = i + 1;
    }
  }
  consider(raw.subarray(start), true);

  return {
    path,
    lines,
    blank,
    skipped,
    // `number` is the file's line count after the loop — 0 for an empty file,
    // counted rather than inferred — which is what `absentEntries` measures
    // the typed numbers against.
    absent: absentEntries(options, number),
    selector: options.lineSet !== null ? "lines" : "from-line",
  };
}

/**
 * The `no such file` refusal, with one conditional clause: when the missing
 * path IS the configured replay queue and the configured local record exists,
 * name the record. A keyless developer is pointed at
 * `log/test_results.jsonl` by the help while their run wrote the other file,
 * and this is the one moment the tool can say so. The guard is the
 * conjunction — equality, not "the path looks like a queue", and an
 * existence check, not "the record is merely configured" — so an ordinary
 * typo keeps the plain message byte-for-byte, and the clause cannot fire on
 * a relative default that happens to resolve against the working directory.
 *
 * The sink pair is resolved HERE, on the error path only, through
 * `readRunnerEnv` — never re-implemented, and never resolved eagerly: the
 * `--list` arm reaches `readSource` before any environment work, and a
 * successful listing must not start paying for it (mirrors the Ruby client,
 * which constructs its own Configuration inside the same arm).
 */
function noSuchFileMessage(path: string, procEnv: Record<string, string | undefined>): string {
  const sinks = readRunnerEnv({ env: procEnv });
  const local = sinks.localOutputPath;
  if (path === sinks.outputPath && existsSync(local)) {
    return (
      `no such file: ${path} — the replay queue was never written, but the ` +
      `local record ${local} does exist (what the reporters write when ` +
      `no API key is configured)`
    );
  }
  return `no such file: ${path}`;
}

/** The whole of the selection, decided in one place. `--lines` keeps whatever it does not name; `--from-line` keeps a prefix. */
function heldBack(number: number, options: Options): boolean {
  if (options.lineSet !== null) {
    return !options.lineSet.some((r) => number >= r.first && number <= r.last);
  }
  return number < options.fromLine;
}

/**
 * The typed numbers the file does not have, in the shorthand they were typed
 * in. Computed ONLY under `--lines`: a `--from-line` past the end of the file
 * is a suffix that selected nothing and already says so through the lines it
 * held back, so widening this to cover it would restate one fact as two.
 *
 * A line the file HAS and that is blank is never here — `blank` already says
 * "you named a line that exists and holds nothing", and stating both would be
 * one line reported under two causes. The comparison is against the file's
 * length alone, which is what keeps that true rather than merely usually
 * true.
 *
 * The clamp is per range, so a range that is only half answered names its
 * portion past the end (`4-9` over a 5-line file → `6-9`) rather than the
 * whole entry, because the satisfied half was honoured. Rendered in the
 * shorthand the user typed — never expanded — and deduplicated, so a repeated
 * absent number is named once.
 */
function absentEntries(options: Options, length: number): string[] {
  if (options.lineSet === null) return [];
  const entries: string[] = [];
  for (const r of options.lineSet) {
    const first = Math.max(r.first, length + 1);
    if (first > r.last) continue;
    entries.push(first === r.last ? String(first) : `${first}-${r.last}`);
  }
  return [...new Set(entries)];
}

function parseOptions(argv: string[]): Options | null {
  let fromLine: number | null = null;
  let lineSet: LineRange[] | null = null;
  let list = false;
  let json = false;
  const files: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      return null; // caller prints usage
    } else if (arg === "--list") {
      list = true;
    } else if (arg === "--json") {
      // Deliberately alongside the selectors rather than instead of them:
      // like --list, it composes with everything — it chooses the renderer,
      // never the set that is listed or sent and never the code that is
      // returned. No single-dash short form exists, here or in the Ruby twin.
      json = true;
    } else if (arg === "--version" || arg === "-v") {
      // The identity query, exactly like --help above: it short-circuits the
      // parse — before the no-file check, before --json is considered, and
      // before any file is read — so a version-only run needs no file, no
      // endpoint and no API key. The caller prints the one line and exits 0.
      return { path: "", fromLine: 1, list: false, lineSet: null, json: false, version: true };
    } else if (arg === "--from-line" || arg === "--lines") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new UsageError(`missing argument: ${arg}`);
      }
      i += 1;
      if (arg === "--from-line") fromLine = parseFromLine(value);
      else lineSet = parseLineSet(value);
    } else if (arg.startsWith("--from-line=")) {
      // The attached form of the same flag, not a second flag: it slices the
      // value and hands it to the SAME validator, so every malformed-spec
      // message is byte-identical to the space form, and last-wins and the
      // mutual-exclusion check below keep working because both forms write
      // the one variable. The "=" is matched EXPLICITLY — a bare
      // startsWith("--from-line") would swallow --from-linex=3, which is a
      // typo and must stay an `invalid option`. Mirrors src/cli.ts's
      // --changed= arm, and matches the Ruby twin, whose OptionParser
      // accepts --flag=value as a matter of course.
      fromLine = parseFromLine(arg.slice("--from-line=".length));
    } else if (arg.startsWith("--lines=")) {
      lineSet = parseLineSet(arg.slice("--lines=".length));
    } else if (arg.startsWith("--")) {
      throw new UsageError(`invalid option: ${arg}`);
    } else {
      files.push(arg);
    }
  }

  if (files.length === 0) throw new UsageError(`no file given — ${BANNER}`);
  if (files.length > 1) {
    throw new UsageError(`one file at a time, got ${files.length}: ${files.join(", ")}`);
  }
  // Refused rather than intersected: both answer "which lines", and an
  // intersection would silently drop a number the user typed
  // (--from-line 5 --lines 3,7 delivering only 7, with the 3 gone without
  // a word). A REPEAT of one flag is last-wins, decided in the loop above —
  // one flag answering its own question twice replaces, never intersects.
  if (fromLine !== null && lineSet !== null) {
    throw new UsageError(
      "--from-line and --lines both choose which lines to send; give one or the other",
    );
  }

  return {
    path: files[0]!,
    fromLine: fromLine ?? 1,
    list,
    lineSet,
    json,
    version: false,
  };
}

/** N ≥ 1, an explicit integer. `--from-line twelve` must not become 0 and deliver the whole file. */
function parseFromLine(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new UsageError(`--from-line wants a line number, got ${JSON.stringify(value)}`);
  }
  const n = Number(value);
  if (n < 1) {
    throw new UsageError(`--from-line must be 1 or greater, got ${value}`);
  }
  return n;
}

/** `3,7,12-15` → ranges, or UsageError naming what was wrong — never a set "close to" what was typed. */
function parseLineSet(spec: string): LineRange[] {
  const entries = spec.split(",").map((e) => e.trim());
  if (entries.length === 0 || (entries.length === 1 && entries[0] === "")) {
    throw new UsageError(`--lines needs at least one line number, got ${JSON.stringify(spec)}`);
  }
  return entries.map((entry) => parseLineSpecEntry(entry, spec));
}

function parseLineSpecEntry(entry: string, spec: string): LineRange {
  if (entry === "") {
    throw new UsageError(`--lines has an empty entry in ${JSON.stringify(spec)}`);
  }
  const match = LINE_SPEC_ENTRY.exec(entry);
  if (match === null) {
    throw new UsageError(
      `--lines: ${JSON.stringify(entry)} is not a line number or a N-M range`,
    );
  }
  const first = Number(match[1]);
  const last = match[2] === undefined ? first : Number(match[2]);
  if (first < 1) {
    throw new UsageError(`--lines: line numbers start at 1, got ${JSON.stringify(entry)}`);
  }
  if (last < first) {
    throw new UsageError(`--lines: ${JSON.stringify(entry)} ends before it starts`);
  }
  return { first, last };
}

function helpText(): string {
  return [
    BANNER,
    "",
    "Re-delivers a saved run to SpecGuard's ingest endpoint. <file> is a file",
    "the reporters wrote — one whole run per line, byte-for-byte the body the",
    "endpoint was offered. The reporters write failed deliveries to the replay",
    "queue, log/test_results.jsonl, and — when no API key is configured —",
    "ordinary local runs to the local development record,",
    "log/test_results.local.jsonl.",
    "",
    "EVERY line in <file> is delivered — or, when you narrow it, every line",
    "--from-line or --lines names. The queue mixes nothing by construction since",
    "the sink split, but a file written by an earlier version (or a local sink",
    "renamed onto it) can hold ordinary keyless local runs beside failed",
    "deliveries, and the two are indistinguishable on the line. Nothing is",
    "filtered and nothing is guessed at.",
    "",
    "So check the file first: --list prints one row per line and delivers",
    "nothing. It needs no SPECGUARD_ENDPOINT and no SPECGUARD_API_KEY. It",
    "composes with --from-line and --lines.",
    "",
    "Options:",
    "  --list            List the runs in <file> without delivering any of them",
    "  --from-line N     Start at line N of <file>, skipping the lines before it",
    "  --lines SPEC      Deliver only the lines SPEC names — numbers and ranges",
    "                    over <file>'s own numbering, e.g. 3,7,12-15. Not",
    "                    combinable with --from-line",
    "  --json            Emit one JSON document on stdout instead of the human report",
    "  -v, --version     Print the version (specguard-ts <version>) and exit",
    "  -h, --help        Print this help and exit",
    "",
    "Reads SPECGUARD_ENDPOINT, SPECGUARD_API_KEY and SPECGUARD_TIMEOUT.",
    "",
    "Exit codes:",
    "  0  every line was accepted — or, with --list, the file was listed",
    "  1  at least one line was refused by the endpoint — it read the payload",
    "     and said no (HTTP 400). Unreachable with --list",
    "  2  this tool could not do its job — bad flags, no endpoint or API key,",
    "     an unreadable file, an unparseable line, a delivery that never",
    "     reached the endpoint, or one the endpoint answered without ever",
    "     reading it (401, 404, 429, 5xx)",
    "",
  ].join("\n");
}

/**
 * Run the command. NEVER THROWS — returns 0, 1 or 2. Diagnostics about this
 * tool's own situation go to stderr; the per-line report and summary (the
 * product) go to stdout.
 */
export async function run(
  argv: string[],
  stdout: IngestStream,
  stderr: IngestStream,
  opts: IngestRunOptions = {},
): Promise<number> {
  try {
    const options = parseOptions(argv);
    if (options === null) {
      stdout.write(helpText());
      return EXIT_OK;
    }

    // Resolved ONCE, for every arm that needs the environment: the delivery
    // arm's credential checks and transport, and the `no such file` clause in
    // `readSource` on BOTH arms (a missing configured queue is diagnosable
    // from `--list` too — that is the arm a keyless developer actually runs).
    const procEnv = opts.env ?? process.env;

    if (options.version) {
      // One line, exit 0 — reached before the no-file check, the credential
      // checks and any file read, mirroring the Ruby client's `-v, --version`.
      stdout.write(`specguard-ts ${version()}\n`);
      return EXIT_OK;
    }

    // --list runs AHEAD of the credential checks, on purpose: listing sends
    // nothing, and the file most worth checking is the one written because no
    // API key was set. A listing that demanded credentials would be
    // unavailable in exactly the case it exists for.
    if (options.list) {
      return await list(options, stdout, stderr, procEnv);
    }

    // Before the file is opened, deliberately: "there is nowhere to send
    // this" is the earlier question, and an unconfigured run should read its
    // one real problem instead of a complaint about a path that was never
    // the point.
    const env = readRunnerEnv({ env: procEnv });
    if (env.endpoint === null) {
      stderr.write("specguard-ingest: error: no endpoint is configured (set SPECGUARD_ENDPOINT)\n");
      return EXIT_MISUSE;
    }
    if (env.apiKey === null) {
      stderr.write("specguard-ingest: error: no API key is configured (set SPECGUARD_API_KEY)\n");
      return EXIT_MISUSE;
    }

    const source = await readSource(options, procEnv);
    const results: LineResult[] = [];
    for (const line of source.lines) {
      results.push(await deliverLine(line.number, line.text, env, opts));
    }

    report(source, results, stdout, stderr, options.json);
    return exitCode(results);
  } catch (err) {
    // A UsageError is this tool answering its caller — a bad flag, a
    // selector that names nothing sensibly, a file that cannot be opened.
    // It is reported in the same register as the endpoint/key checks above:
    // an ordinary `error:`, never `internal error:` — a typo'd path is user
    // input about the run, not a bug in this tool.
    if (err instanceof UsageError) {
      stderr.write(`specguard-ingest: error: ${err.message}\n`);
      return EXIT_MISUSE;
    }
    // The backstop that keeps exit 1 meaning one thing: anything else
    // reaching here is a bug in this tool, not a verdict from the endpoint
    // about anyone's run, so it is a 2 and it says so in those words.
    const what = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    stderr.write(`specguard-ingest: internal error: ${what}\n`);
    return EXIT_MISUSE;
  }
}

/** 2 dominates; 1 is produced ONLY over a `refused` result. */
function exitCode(results: LineResult[]): number {
  if (results.some((r) => r.status === "undelivered" || r.status === "unparseable")) {
    return EXIT_MISUSE;
  }
  if (results.some((r) => r.status === "refused")) {
    return EXIT_REFUSED;
  }
  return EXIT_OK;
}

async function deliverLine(
  number: number,
  text: string | null,
  env: RunnerEnv,
  opts: IngestRunOptions,
): Promise<LineResult> {
  if (text === null) {
    // The reference's verdict, verbatim: such a line cannot be a run. No
    // code, because no request was ever built.
    const problem = "the line is not valid UTF-8, so it cannot be a run";
    return {
      number,
      status: "unparseable",
      detail: problem,
      code: null,
      reasons: [problem],
      testRunId: null,
      ciRunId: null,
    };
  }

  const parsed = parsePayload(text);
  if ("problem" in parsed) {
    return {
      number,
      status: "unparseable",
      detail: parsed.problem,
      code: null,
      reasons: [parsed.problem],
      testRunId: null,
      ciRunId: null,
    };
  }

  // Reporting metadata ONLY — the POST body below is `text`, the line's own
  // bytes, never a re-stringification of this parse.
  const ciRunId = scalar(parsed.payload.ci_run_id);

  const raw = await deliverRawLine(text, env, opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl });
  if (raw.outcome === "accepted") {
    return {
      number,
      status: "accepted",
      detail: `HTTP ${raw.status}`,
      code: raw.status,
      reasons: [],
      testRunId: raw.testRunId,
      ciRunId,
    };
  }
  if (raw.outcome === "http-error") {
    const detail = raw.detail === "" ? `HTTP ${raw.status}` : `HTTP ${raw.status} — ${raw.detail}`;
    return {
      number,
      status: CONTENT_REFUSAL_CODES.includes(raw.status) ? "refused" : "undelivered",
      detail,
      code: raw.status,
      // `raw.reasons` verbatim — the whole array off the refusal body, not
      // the fragment the `detail` line flattens it to; `null` when the body
      // said nothing readable, which the reporter renders as `[]`.
      reasons: raw.reasons,
      testRunId: null,
      ciRunId,
    };
  }
  // No code, because no answer: the error's rendering is the whole of what
  // there is to say, and it is the only thing `reasons` can carry.
  return {
    number,
    status: "undelivered",
    detail: raw.detail,
    code: null,
    reasons: [raw.detail],
    testRunId: null,
    ciRunId,
  };
}

function lineReport(result: LineResult): string {
  let line = `line ${result.number}: ${STATUS_LABELS[result.status]} — ${result.detail}`;
  if (result.status === "accepted") {
    line += `, test_run_id ${result.testRunId ?? "(not reported)"}`;
    line += result.ciRunId !== null ? `, ci_run_id ${result.ciRunId}` : ", no ci_run_id";
  }
  return line;
}

/** Folding, stated only where it was SEEN: same ci_run_id in, same test_run_id out, ≥2 lines. */
function foldedRuns(results: LineResult[]): Folding[] {
  const groups = new Map<string, LineResult[]>();
  for (const r of results) {
    if (r.status !== "accepted" || r.ciRunId === null || r.testRunId === null) continue;
    const key = `${r.ciRunId}\u0000${r.testRunId}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [r]);
    else group.push(r);
  }
  return [...groups.values()]
    .filter((g) => g.length >= 2)
    .map((g) => ({
      ciRunId: g[0]!.ciRunId!,
      testRunId: g[0]!.testRunId!,
      numbers: g.map((r) => r.number),
    }));
}

function skippedClause(source: Source): string {
  // Named for the flag that held them back, worded for what that flag does:
  // --from-line holds back a prefix ("earlier"); --lines holds back whatever
  // it did not name, which can sit anywhere in the file.
  if (source.selector === "lines") {
    return plural(source.skipped, "line") + " not selected by --lines";
  }
  return plural(source.skipped, "earlier line") + " skipped by --from-line";
}

function blankClause(source: Source): string {
  return plural(source.blank, "blank line") + " skipped";
}

/**
 * The typed numbers the file does not have, named rather than counted —
 * {@link skippedClause}'s counterpart for the other direction: that one says
 * how much of the FILE the selector held back, and this one says how much of
 * the SELECTOR the file could not answer. A count would be the wrong shape
 * here — the reader's next action is editing the numbers they typed, so the
 * clause hands those numbers back in the form they wrote them.
 */
function absentClause(source: Source): string {
  return `--lines named ${source.absent.join(", ")}, which the file does not have`;
}

/** Why there was nothing to do, when there is a reason other than "the file is empty". */
function emptyDetail(source: Source): string {
  const parts: string[] = [];
  if (source.blank > 0) parts.push(blankClause(source));
  if (source.skipped > 0) parts.push(skippedClause(source));
  if (source.absent.length > 0) parts.push(absentClause(source));
  return parts.length === 0 ? "" : ` (${parts.join("; ")})`;
}

function statusCounts(results: LineResult[]): StatusCounts {
  const counts: StatusCounts = { accepted: 0, refused: 0, undelivered: 0, unparseable: 0 };
  for (const r of results) counts[r.status] += 1;
  return counts;
}

/**
 * The per-line report on stdout — it is the product — with the diagnostics
 * about this tool's own situation on stderr. `--json` moves the product and
 * leaves the diagnostics: a run that delivered nothing is still loud on
 * stderr, in both renderers, because the warning is a statement about this
 * tool's situation and not a result.
 *
 * Two renderers, one set of facts: the counts and the folding groups are
 * computed ONCE here and handed to whichever renderer runs — a command whose
 * two renderers can disagree about how much of a file it delivered is worse
 * than one that only prints prose.
 */
function report(
  source: Source,
  results: LineResult[],
  stdout: IngestStream,
  stderr: IngestStream,
  json: boolean,
): void {
  if (results.length === 0) {
    stderr.write(
      `specguard-ingest: warning: ${source.path} holds no runs to deliver${emptyDetail(source)}\n`,
    );
    // An empty file still writes the document under --json — the file was
    // read, and `"lines": []` over a summary of zeroes is a true statement
    // about it. Only a run that never got as far as reading <file> (a bad
    // flag, no credentials, an unreadable file) writes no document at all.
    if (!json) return;
  }

  const counts = statusCounts(results);
  const foldings = foldedRuns(results);

  if (json) {
    stdout.write(renderDelivery({ source, results, counts, foldings }));
    return;
  }

  for (const result of results) {
    stdout.write(`${lineReport(result)}\n`);
  }
  stdout.write(`${summaryLine(source, results, counts)}\n`);
  for (const folding of foldings) {
    stdout.write(
      `specguard-ingest: lines ${folding.numbers.join(", ")} carried ci_run_id ${folding.ciRunId} ` +
        `and each came back with test_run_id ${folding.testRunId} — the endpoint folded them onto one run\n`,
    );
  }
}

function summaryLine(source: Source, results: LineResult[], counts: StatusCounts): string {
  const parts = [
    `specguard-ingest: delivered ${counts.accepted} of ${plural(results.length, "run")} from ${source.path}`,
  ];
  if (counts.refused > 0) parts.push(`${counts.refused} refused`);
  if (counts.undelivered > 0) parts.push(`${counts.undelivered} could not be delivered`);
  if (counts.unparseable > 0) parts.push(`${counts.unparseable} could not be parsed`);
  if (source.blank > 0) parts.push(blankClause(source));
  if (source.skipped > 0) parts.push(skippedClause(source));
  if (source.absent.length > 0) parts.push(absentClause(source));
  return parts.join("; ");
}

/**
 * `--list`: read the file, print what is in it, deliver nothing. Never routes
 * through exitCode — listing makes no request, so no endpoint has read
 * anything and exit 1 is unreachable by construction.
 */
async function list(
  options: Options,
  stdout: IngestStream,
  stderr: IngestStream,
  procEnv: Record<string, string | undefined>,
): Promise<number> {
  const source = await readSource(options, procEnv);
  const lines = source.lines.map((line) => listedLine(line.number, line.text));

  if (lines.length === 0) {
    stderr.write(
      `specguard-ingest: warning: ${source.path} holds no runs to list${emptyDetail(source)}\n`,
    );
    // Under --json the empty listing still writes the document — the file
    // was read, and `"lines": []` over a summary of zeroes is a true
    // statement about it; a file that could not be read raised before there
    // was anything to be a document about.
    if (!options.json) return EXIT_OK;
  }

  if (options.json) {
    stdout.write(renderListing({ source, lines, counts: listedCounts(lines) }));
    return EXIT_OK;
  }

  for (const line of lines) {
    stdout.write(`${listRow(line)}\n`);
  }
  const parts = [
    `specguard-ingest: listed ${plural(source.lines.length, "line")} from ${source.path}`,
  ];
  if (source.blank > 0) parts.push(blankClause(source));
  if (source.skipped > 0) parts.push(skippedClause(source));
  if (source.absent.length > 0) parts.push(absentClause(source));
  parts.push("nothing was delivered");
  stdout.write(`${parts.join("; ")}\n`);
  return EXIT_OK;
}

/**
 * The listing's counterpart to statusCounts. A preview delivers nothing, so
 * `unparseable` is the only status a listed line can hold — but it is counted
 * HERE, beside the delivery path's counts, not inside the renderer: a count
 * computed in the one place that promises not to compute them is the
 * discipline holding by structure rather than by luck.
 */
function listedCounts(lines: ListedLine[]): StatusCounts {
  return {
    accepted: 0,
    refused: 0,
    undelivered: 0,
    unparseable: lines.filter((l) => l.problem !== null).length,
  };
}

function listedLine(number: number, text: string | null): ListedLine {
  if (text === null) {
    return {
      number,
      problem: "the line is not valid UTF-8, so it cannot be a run",
      branch: null,
      commitSha: null,
      ciRunId: null,
      examples: null,
      durationSeconds: null,
    };
  }
  const parsed = parsePayload(text);
  if ("problem" in parsed) {
    return {
      number,
      problem: parsed.problem,
      branch: null,
      commitSha: null,
      ciRunId: null,
      examples: null,
      durationSeconds: null,
    };
  }
  const specs = parsed.payload.specs;
  const duration = parsed.payload.duration_seconds;
  return {
    number,
    problem: null,
    branch: scalar(parsed.payload.branch),
    commitSha: scalar(parsed.payload.commit_sha),
    ciRunId: scalar(parsed.payload.ci_run_id),
    // `0 examples` and `no specs` are different facts: an empty array is a
    // run that carried none; a missing or non-array `specs` is a line that
    // does not say.
    examples: Array.isArray(specs) ? specs.length : null,
    durationSeconds: typeof duration === "number" ? duration : null,
  };
}

function listRow(line: ListedLine): string {
  if (line.problem !== null) {
    return `line ${line.number}: ${STATUS_LABELS.unparseable} — ${line.problem}`;
  }
  const fields = [
    named("branch", line.branch),
    named("commit_sha", line.commitSha),
    named("ci_run_id", line.ciRunId),
    line.examples !== null ? plural(line.examples, "example") : "no specs",
    line.durationSeconds !== null ? `${line.durationSeconds}s` : "no duration_seconds",
  ];
  return `line ${line.number}: ${fields.join(", ")}`;
}

function named(name: string, value: string | null): string {
  // Empty string is "not said", matching the reference's truthiness check —
  // a branch of "" renders as `no branch`, not as `branch `.
  return value !== null && value !== "" ? `${name} ${value}` : `no ${name}`;
}
