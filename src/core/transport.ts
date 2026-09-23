import { mkdir, appendFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import type { Envelope } from "./types.js";
import type { RunnerEnv } from "./env.js";

/** Bodies over this size are gzipped — the Ruby client's threshold. */
export const GZIP_THRESHOLD_BYTES = 256 * 1024;

export interface TransportDeps {
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. Defaults to a single line on process.stderr. */
  warn?: (message: string) => void;
  /** Injectable for tests. Defaults to fs promises appendFile. */
  appendFileImpl?: (path: string, data: string) => Promise<void>;
}

export interface DeliveryResult {
  delivered: boolean;
  /**
   * "sent" | "fell-back" | "lost" | "skipped" | "no-commit"
   *
   * "lost" — the endpoint refused the run AND the replay queue could not be
   * written either: the run's telemetry is gone. It is distinct from
   * "fell-back", which now means exactly one thing — the queue write
   * succeeded.
   */
  outcome: "sent" | "fell-back" | "lost" | "skipped" | "no-commit";
}

function defaultWarn(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function appendFileDefault(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, data);
}

function oneLine(text: string): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length > 300 ? `${flattened.slice(0, 300)}…` : flattened;
}

/**
 * The refusal body's per-spec reasons, on exactly the Ruby Transport's
 * `refusal_reasons` predicates (`lib/specguard/rspec/transport.rb`):
 *
 *   - the body must be a JSON **object** — a scalar or an array says nothing
 *     this tool can name;
 *   - `details` must be a NON-EMPTY array of ALL strings — the platform sends
 *     one error per offending spec (`render_bad_request` puts every one of
 *     them on the wire), and a partial list would under-report;
 *   - otherwise a `message` string stands alone as the one fallback;
 *   - anything unreadable degrades silently to `null` — today's raw-text
 *     `detail` is served unchanged, never a new failure mode.
 *
 * The guard sits at the read rather than the call, for the reason the Ruby
 * method gives: a body that will not parse is not a delivery failure — the
 * delivery plainly succeeded and was refused — and relabelling a 400 as an
 * exception would tell the operator something untrue. It covers the empty
 * body, the HTML a proxy answers a 413 with, a JSON scalar, and anything else
 * a non-SpecGuard peer might put on the wire.
 *
 * Callers hand in the body string they ALREADY read for the `detail` line:
 * `res.text()` can only be consumed once, so the parse and the one-line
 * rendering must share one read.
 */
export function refusalReasons(bodyText: string): string[] | null {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const details = record.details;
  if (Array.isArray(details) && details.length > 0 && details.every((d) => typeof d === "string")) {
    return details as string[];
  }
  const message = record.message;
  return typeof message === "string" ? [message] : null;
}

/**
 * Deliver one envelope to `<endpoint>/api/v1/ingest`.
 *
 * NEVER THROWS. This is the roadmap's hardest constraint and it outranks
 * every other goal: telemetry may be lost, a test run may not be. Node's
 * `fetch` resolves a 401 or a 500 as an ordinary Response — nothing is
 * thrown — so `res.ok` is checked explicitly rather than left to a `catch`,
 * and a wrong API key would otherwise vanish in complete silence.
 *
 * No retries. The whole delivery is bounded by the timeout.
 */
export async function deliver(
  envelope: Envelope,
  env: RunnerEnv,
  deps: TransportDeps = {},
): Promise<DeliveryResult> {
  const warn = deps.warn ?? defaultWarn;
  const append = deps.appendFileImpl ?? appendFileDefault;

  const json = JSON.stringify(envelope);

  // The API key is the switch: with no key (or no endpoint) nothing is sent
  // anywhere and the run is written to the LOCAL SINK — the local development
  // record, not the replay queue. A keyless run (local dev, a fork PR with no
  // secret) is a laptop run, not a failed delivery, and writing it to the
  // replay queue would promise recoverability the queue cannot keep: nothing
  // on the line says which sink it was destined for, so once the two meanings
  // share a file they can never be separated again.
  if (env.apiKey === null || env.endpoint === null) {
    try {
      await append(env.localOutputPath, `${json}\n`);
    } catch (err) {
      warn(
        `SpecGuard: could not write telemetry to ${env.localOutputPath} (${errorMessage(err)}). The test run is unaffected.`,
      );
    }
    return { delivered: false, outcome: "skipped" };
  }

  const url = `${env.endpoint.replace(/\/+$/, "")}/api/v1/ingest`;
  const fetchImpl = deps.fetchImpl ?? fetch;

  try {
    const res = await postJson(json, url, env, fetchImpl);

    // fetch does NOT throw on a 401 or a 500 — this explicit check is the
    // load-bearing line; without it a refused delivery disappears silently.
    if (!res.ok) {
      let detail = "";
      try {
        detail = oneLine(await res.text());
      } catch {
        detail = "";
      }
      return fallBackToQueue(
        `SpecGuard: could not deliver test telemetry (HTTP ${res.status}${detail === "" ? "" : ` — ${detail}`})`,
        append,
        warn,
        env,
        json,
      );
    }

    // Drain the body so the socket is released cleanly.
    try {
      await res.arrayBuffer();
    } catch {
      // A body that cannot be drained after a 2xx is not a delivery failure.
    }
    return { delivered: true, outcome: "sent" };
  } catch (err) {
    return fallBackToQueue(
      `SpecGuard: could not deliver test telemetry (${errorMessage(err)})`,
      append,
      warn,
      env,
      json,
    );
  }
}

/**
 * The sink half of a refused delivery, composed from the write's OWN answer —
 * report, not promise (the Ruby Transport's shape, SPGD-1413's
 * `#append`/`#fall_back`). Before SPGD-1418 the refusal line promised
 * `Falling back to <path>; the test run is unaffected.` BEFORE the write ran,
 * so a queue that could not be written either printed that false promise and
 * a second, equally false "unaffected" — and `deliver` returned
 * `outcome: "fell-back"` for a run that went nowhere.
 *
 * The delivery status clause (`HTTP 401`, the fetch error) is settled by the
 * caller and stays the first fact on the wire — the order of reasoning does
 * not move; only the sink clause now waits for the write it describes:
 *
 *   - the queue write succeeded → the historical one-line shape, byte for
 *     byte: `<status clause>. Falling back to <path>; the test run is
 *     unaffected.` — outcome `"fell-back"`.
 *   - the queue write failed too → the status clause alone (no promise), then
 *     a second line that names the queue path and states the loss:
 *     `SpecGuard: could not write telemetry to <path> (<error>), so this
 *     run's telemetry was lost.` — outcome `"lost"`.
 *
 * Still never throws: the write's rejection is the return value's input, not
 * an escape.
 */
async function fallBackToQueue(
  statusClause: string,
  append: (path: string, data: string) => Promise<void>,
  warn: (message: string) => void,
  env: RunnerEnv,
  json: string,
): Promise<DeliveryResult> {
  let writeError: unknown = null;
  try {
    await append(env.outputPath, `${json}\n`);
  } catch (err) {
    writeError = err;
  }
  if (writeError !== null) {
    warn(`${statusClause}.`);
    warn(
      `SpecGuard: could not write telemetry to ${env.outputPath} (${errorMessage(writeError)}), so this run's telemetry was lost.`,
    );
    return { delivered: false, outcome: "lost" };
  }
  warn(`${statusClause}. Falling back to ${env.outputPath}; the test run is unaffected.`);
  return { delivered: false, outcome: "fell-back" };
}

/**
 * The one request this package makes, built once: URL join, gzip threshold,
 * Authorization, Content-Type, User-Agent, and the bounded timeout. `deliver`
 * and the replay bin's raw seam both go through here so the two paths cannot
 * drift — a replay must reach the endpoint exactly as the reporter's own
 * delivery would have.
 */
async function postJson(
  json: string,
  url: string,
  env: RunnerEnv,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const byteLength = Buffer.byteLength(json, "utf8");
  const gzip = byteLength > GZIP_THRESHOLD_BYTES;
  const body =
    gzip ? gzipSync(Buffer.from(json, "utf8")) : Buffer.from(json, "utf8");

  return fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.apiKey}`,
      "Content-Type": "application/json",
      ...(gzip ? { "Content-Encoding": "gzip" } : {}),
      "User-Agent": userAgent(),
    },
    body,
    signal: AbortSignal.timeout(env.timeoutMs),
  });
}

export interface RawDeliveryDeps {
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export type RawDeliveryResult =
  /** A 2xx. `testRunId` is the 202 body's run id when one was readable. */
  | { outcome: "accepted"; status: number; testRunId: string | null }
  /**
   * fetch resolved a non-2xx — the endpoint answered without storing.
   * `reasons` is the refusal body's per-spec `details` array (or the
   * `message` fallback), whole and uncapped — the structured half of what
   * the truncated `detail` line flattens; `null` when the body said nothing
   * readable. Beside `detail`, never instead of it.
   */
  | { outcome: "http-error"; status: number; detail: string; reasons: string[] | null }
  /** The request never got an answer — refused connection, DNS, timeout. */
  | { outcome: "network-error"; detail: string };

/**
 * Deliver ONE saved line's exact bytes to `<endpoint>/api/v1/ingest` — the
 * raw-body seam the `specguard-ingest` replay bin rides.
 *
 * Unlike `deliver`, this never writes a fallback file: the line is already
 * on disk, and a replay that re-appended it on failure would duplicate it
 * in the queue. Callers own both the file and the reporting.
 *
 * `line` is the saved line's own text, and it is posted as-is — never
 * parsed-then-re-stringified. Node's `JSON.parse` accepts what the protocol
 * rejects (a lone `\ud800` escape parses, then silently repairs to U+FFFD on
 * re-encode), so nothing between the file and the wire may go through a
 * value round-trip that could rewrite it; a valid-UTF-8 line re-encodes to
 * its own bytes, which is what makes the string seam safe. `env` should
 * carry a non-null `endpoint` and `apiKey` — callers check before invoking.
 */
export async function deliverRawLine(
  line: string,
  env: RunnerEnv,
  deps: RawDeliveryDeps = {},
): Promise<RawDeliveryResult> {
  if (env.endpoint === null || env.apiKey === null) {
    // Callers check before invoking; this guard keeps the never-throw
    // contract honest for a direct call rather than building a "Bearer null"
    // request against an "undefined" URL.
    return { outcome: "network-error", detail: "no endpoint or API key configured" };
  }
  const url = `${env.endpoint.replace(/\/+$/, "")}/api/v1/ingest`;

  try {
    const res = await postJson(line, url, env, deps.fetchImpl ?? fetch);

    if (res.ok) {
      return {
        outcome: "accepted",
        status: res.status,
        testRunId: await successTestRunId(res),
      };
    }

    // ONE read of the body: `res.text()` can only be consumed once, so the
    // flattened `detail` line and the `reasons` parse share the same string.
    // A body that will not read or parse degrades — `detail` flattens to ""
    // and `reasons` stays null — never a throw; the never-fail contract
    // outranks the decoration.
    let detail = "";
    let reasons: string[] | null = null;
    try {
      const body = await res.text();
      detail = oneLine(body);
      reasons = refusalReasons(body);
    } catch {
      detail = "";
    }
    return { outcome: "http-error", status: res.status, detail, reasons };
  } catch (err) {
    return { outcome: "network-error", detail: errorMessage(err) };
  }
}

/** The 202 body's `test_run_id`, or null when the body said nothing usable. */
async function successTestRunId(res: Response): Promise<string | null> {
  try {
    const body: unknown = JSON.parse(await res.text());
    if (body !== null && typeof body === "object" && !Array.isArray(body)) {
      const id = (body as { test_run_id?: unknown }).test_run_id;
      return typeof id === "string" && id !== "" ? id : null;
    }
    return null;
  } catch {
    return null;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return oneLine(err.message);
  return oneLine(String(err));
}

function userAgent(): string {
  return `specguard-ts/${version()}`;
}

let cachedVersion: string | null = null;
export function version(): string {
  if (cachedVersion !== null) return cachedVersion;
  cachedVersion = readPackageVersion();
  return cachedVersion;
}

/**
 * Walk UP from this module to the package root and read the first
 * package.json that names this package.
 *
 * The original read was a fixed `"../package.json"`, which resolves against
 * the module's OWN directory — `<pkg>/dist/core` in every layout that ships —
 * so `../package.json` named `<pkg>/dist/package.json`, which does not exist.
 * The lookup therefore answered the `"0.0.0"` fallback in every built layout
 * (the dist build, an npm install, and the test build alike): the User-Agent
 * test only pinned `/^specguard-ts\//`, so nothing ever caught it, and every
 * delivery advertised `specguard-ts/0.0.0`. Walking up (bounded, and
 * name-checked — an ancestor monorepo or vendoring application's
 * package.json must never be mistaken for this package's) finds the true
 * manifest in every layout; a tree without one still answers `"0.0.0"`.
 * Still exactly one read, still createRequire — this package is ESM — and
 * still cached by `version()` above.
 */
function readPackageVersion(): string {
  const require = createRequire(import.meta.url);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const pkg = require(join(dir, "package.json")) as
        | { name?: unknown; version?: unknown }
        | undefined;
      if (pkg !== undefined && pkg.name === "@yatfa/specguard" && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      // No manifest at this level — keep walking toward the root.
    }
    const parent = dirname(dir);
    if (parent === dir) break; // the filesystem root
    dir = parent;
  }
  return "0.0.0";
}
