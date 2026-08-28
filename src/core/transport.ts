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
  // anywhere and the run is written to the local sink.
  if (env.apiKey === null || env.endpoint === null) {
    try {
      await append(env.outputPath, `${json}\n`);
    } catch (err) {
      warn(
        `SpecGuard: could not write telemetry to ${env.outputPath} (${errorMessage(err)}). The test run is unaffected.`,
      );
    }
    return { delivered: false, outcome: "skipped" };
  }

  const url = `${env.endpoint.replace(/\/+$/, "")}/api/v1/ingest`;
  const fetchImpl = deps.fetchImpl ?? fetch;

  try {
    const byteLength = Buffer.byteLength(json, "utf8");
    const gzip = byteLength > GZIP_THRESHOLD_BYTES;
    const body =
      gzip ? gzipSync(Buffer.from(json, "utf8")) : Buffer.from(json, "utf8");

    const res = await fetchImpl(url, {
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
