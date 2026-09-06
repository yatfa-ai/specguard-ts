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

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Is this module the process entry point? The ESM stand-in for
 * `require.main === module`, and it MUST compare real paths.
 *
 * npm installs a bin as a symlink — `node_modules/.bin/specguard-ingest ->
 * ../@yatfa/specguard/dist/ingest-cli.js` — and Node does NOT resolve it for
 * `process.argv[1]`: the entry point reports the LINK's own path, which ends
 * in the bin's name and not in this file's name. A guard that compared
 * filename suffixes therefore read false for every installed consumer, so the
 * bin loaded, ran nothing and exited 0 — a silent no-op rather than anything
 * diagnosable, and invisible to a test that invokes the file by path.
 * `realpathSync` on both sides makes the link and its target the same file.
 *
 * Only `node:` builtins are imported for this. The lazy `import()` below is
 * load-bearing (see above), and a static import of a FIRST-PARTY module would
 * both defeat it and break the test that copies this one file to a temp
 * directory to exercise the failure path.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  try {
    const { run } = await import("./core/ingest-cli.js");
    process.exit(await run(process.argv.slice(2), process.stdout, process.stderr));
  } catch (err) {
    const what = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    process.stderr.write(`specguard-ingest: error: could not load @yatfa/specguard: ${what}\n`);
    process.exit(2);
  }
}
