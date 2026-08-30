#!/usr/bin/env node
/**
 * `specguard-ingest` — the replay bin (slice 6).
 *
 * Replays a saved run through SpecGuard's ingest endpoint, byte-for-byte:
 * see `src/core/ingest-cli.ts` for the exit contract (0/1/2) and the
 * selectors. The real work is imported lazily inside the try below so that a
 * module that cannot even load is a 2 with one stderr line, never a stack
 * trace — mirroring the Ruby bin's `require` guard. Left bare, Node would
 * exit 1 on an import failure and report that the platform refused a run it
 * was never offered.
 */

if (process.argv[1] !== undefined && process.argv[1].endsWith("ingest-cli.js")) {
  try {
    const { run } = await import("./core/ingest-cli.js");
    process.exit(await run(process.argv.slice(2), process.stdout, process.stderr));
  } catch (err) {
    const what = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    process.stderr.write(`specguard-ingest: error: could not load specguard-ts: ${what}\n`);
    process.exit(2);
  }
}
