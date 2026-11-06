/**
 * Convert a runner-reported duration in MILLISECONDS into the wire field
 * `duration`, which is SECONDS. A missing or invalid value (not a number,
 * NaN, infinite, negative) ships `null` — never a fabricated or negative
 * duration. `0` is a real measurement and stays `0`.
 */
export function msToSeconds(ms: unknown): number | null {
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null;
}
