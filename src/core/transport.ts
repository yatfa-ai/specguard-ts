import { mkdir, appendFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
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
  /** "sent" | "fell-back" | "skipped" | "no-commit" */
  outcome: "sent" | "fell-back" | "skipped" | "no-commit";
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
      warn(
        `SpecGuard: could not deliver test telemetry (HTTP ${res.status}${detail === "" ? "" : ` — ${detail}`}). Falling back to ${env.outputPath}; the test run is unaffected.`,
      );
      await writeFallback(append, warn, env, json);
      return { delivered: false, outcome: "fell-back" };
    }

    // Drain the body so the socket is released cleanly.
    try {
      await res.arrayBuffer();
    } catch {
      // A body that cannot be drained after a 2xx is not a delivery failure.
    }
    return { delivered: true, outcome: "sent" };
  } catch (err) {
    warn(
      `SpecGuard: could not deliver test telemetry (${errorMessage(err)}). Falling back to ${env.outputPath}; the test run is unaffected.`,
    );
    await writeFallback(append, warn, env, json);
    return { delivered: false, outcome: "fell-back" };
  }
}

async function writeFallback(
  append: (path: string, data: string) => Promise<void>,
  warn: (message: string) => void,
  env: RunnerEnv,
  json: string,
): Promise<void> {
  try {
    await append(env.outputPath, `${json}\n`);
  } catch (err) {
    warn(
      `SpecGuard: could not write telemetry to ${env.outputPath} (${errorMessage(err)}). The test run is unaffected.`,
    );
  }
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
  /** fetch resolved a non-2xx — the endpoint answered without storing. */
  | { outcome: "http-error"; status: number; detail: string }
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

    let detail = "";
    try {
      detail = oneLine(await res.text());
    } catch {
      detail = "";
    }
    return { outcome: "http-error", status: res.status, detail };
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
function version(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    // createRequire, not `require` — this package is ESM.
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string } | undefined;
    cachedVersion =
      pkg !== undefined && typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}
