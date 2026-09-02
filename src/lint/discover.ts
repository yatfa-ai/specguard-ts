import fs from "node:fs";
import path from "node:path";

/**
 * Discovery half of `specguard lint`: which source files are in scope, and
 * which of them carry `@intent:` tokens.
 *
 * The scan here is a TOKEN SCAN and nothing more. It never parses an
 * annotation payload: PROTOCOL.md §1.1(a) (the accepted JSON language) is
 * enforced by the `validate-intent` binary alone, precisely because a
 * client-side parser (Node's `JSON.parse`) accepts payloads the protocol
 * rejects — an unpaired-surrogate escape would lint green in TypeScript and
 * red under the binary every other stack shares. Discovery answers exactly
 * two questions the binary cannot answer on its own:
 *
 *   1. WHICH files are in scope for this repository (extension-gated walk
 *      or the explicit list the caller named);
 *   2. whether ANY in-scope file carries a token — the gate that keeps an
 *      annotation-free repository exit 0 even when no binary resolves
 *      ("empty ≠ failure" is the contract, and "could not validate" must
 *      never be produced by a repository that simply has nothing to check).
 *
 * Anything the token scan finds is then handed to the binary as SOURCE FILES
 * (`--source`): the binary's own extractor decides what is and is not an
 * annotation, so this scan can never produce a verdict, only a count.
 */

/** Extensions whose files carry `@intent:` annotations. */
export const ANNOTATED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

/** Directories that are never walked: dependencies, build output, VCS. */
export const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  ".test-build",
  "coverage",
]);

/** The annotation marker, spelled once. */
export const INTENT_TOKEN = "@intent:";

export interface FileSelection {
  /** In-scope files, in discovery order (explicit order is preserved). */
  files: string[];
  /** "explicit" when the caller named files, "walk" when the tree was searched. */
  mode: "explicit" | "walk";
}

export interface FileScan {
  file: string;
  /** Token occurrences on any line — a gate count, never a verdict. */
  tokens: number;
  /** True when the file could not be scanned at all (unreadable, or over
   * SCAN_MAX_BYTES) — a `tokens: 0` on such a file means "could not look",
   * never "looked and found nothing". */
  unscannable: boolean;
}

export class LintUsageError extends Error {}

function isAnnotatedSource(file: string): boolean {
  const ext = path.extname(file).toLowerCase();
  return (ANNOTATED_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * Select in-scope files. Explicit paths are checked AS GIVEN (a named
 * non-annotated extension is a usage error, not silently skipped — the same
 * anti-quiet-no-op rule the Ruby client's `--changed`/files combination
 * follows); with no paths the `root` is walked recursively.
 */
export function selectFiles(paths: string[], root = process.cwd()): FileSelection {
  if (paths.length > 0) {
    for (const p of paths) {
      if (!isAnnotatedSource(p)) {
        throw new LintUsageError(
          `${p} is not an annotated source file (${ANNOTATED_EXTENSIONS.join(", ")})`,
        );
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(p);
      } catch {
        continue; // unreadable named files are the BINARY's read findings, not ours
      }
      if (stat.isDirectory()) {
        throw new LintUsageError(`${p} is a directory; name files or run without paths`);
      }
    }
    return { files: [...paths], mode: "explicit" };
  }

  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // an unreadable directory is reported by the walk being smaller, never a crash
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.isFile() && isAnnotatedSource(entry.name)) {
        files.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root);
  return { files, mode: "walk" };
}

/** Byte budget for one file's scan — a source file, not an asset bundle. */
export const SCAN_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Count `@intent:` token occurrences per file. Line-granular and
 * string-blind by design (§7 of the protocol notes): the count gates and
 * summarizes; the binary decides what the tokens mean. An unreadable or
 * oversized file counts zero tokens, keeps its place in the list, and is
 * flagged `unscannable` — when a binary resolves, IT still reports the read
 * failure; when none does, that flag is the only witness separating "could
 * not look at this file" from "nothing to check" (SPGD-926: both used to be
 * the same `tokens: 0`, and the no-binary degrade trusted it).
 */
export function scanTokens(files: string[]): FileScan[] {
  return files.map((file) => {
    let text: string;
    try {
      const buf = fs.readFileSync(file);
      if (buf.byteLength > SCAN_MAX_BYTES) return { file, tokens: 0, unscannable: true };
      text = buf.toString("utf8");
    } catch {
      return { file, tokens: 0, unscannable: true };
    }
    let tokens = 0;
    let at = text.indexOf(INTENT_TOKEN);
    while (at !== -1) {
      tokens += 1;
      at = text.indexOf(INTENT_TOKEN, at + INTENT_TOKEN.length);
    }
    return { file, tokens, unscannable: false };
  });
}
