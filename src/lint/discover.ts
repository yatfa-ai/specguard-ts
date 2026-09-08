import fs from "node:fs";
import { execFileSync } from "node:child_process";
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

/**
 * Ordered probes for the default branch when no explicit `--changed=<base>`
 * is given, in the Ruby client's settled order (`specguard-rspec`
 * `file_selector.rb` — the contract this port mirrors): the symbolic
 * `origin/HEAD` first, then the two remote mains, then the local names.
 */
export const DEFAULT_BRANCH_REFS = [
  "origin/HEAD",
  "origin/main",
  "origin/master",
  "main",
  "master",
] as const;

/**
 * Why an empty `--changed` selection is empty: one count per filter the
 * selector applied, in the order it applied them, so the empty-reason can
 * name the real cause instead of guessing at the last one. The Ruby client's
 * `Stats`, carried for the same reason it is there.
 */
export interface ChangedStats {
  /** Paths the diff named (deleted paths never arrive — see `diffNames`). */
  changed: number;
  /** Of those, the ones matching the annotated extensions. */
  matches: number;
  /** Matched files that live outside the selection root (the cwd). */
  outsideRoot: number;
  /** Matched, in-root paths that are not existing regular files. */
  unreadable: number;
}

export interface FileSelection {
  /** In-scope files, in discovery order (explicit order is preserved). */
  files: string[];
  /** "explicit" when the caller named files, "walk" when the tree was
   * searched, "changed" when the git diff against a base selected them. */
  mode: "explicit" | "walk" | "changed";
  /** `changed` mode: the resolved diff base (a merge base, HEAD, or the
   * caller's explicit `--changed=<base>`). Null in the other modes. */
  base: string | null;
  /** `changed` mode: disclosure for a base that can only produce a thin
   * selection (no default ref found → HEAD fallback, or the base IS HEAD).
   * Null when the base needs no apology. Null in the other modes. */
  note: string | null;
  /** `changed` mode: the filter counters behind an empty selection. Null in
   * the other modes. */
  stats: ChangedStats | null;
}

/** Options for `selectFiles` beyond the positional paths. */
export interface SelectOptions {
  /** Select from the git diff instead of walking (the `--changed` mode). */
  changed?: boolean | undefined;
  /** Explicit diff base (the `--changed=<base>` form); undefined derives the
   * merge base with the default branch. Deliberately NOT defaulted: an
   * explicit EMPTY base stays explicit and fails loudly at the diff, exactly
   * as the Ruby client's truthy `""` does. */
  base?: string | undefined;
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
 * follows); with no paths the `root` is walked recursively; with `changed`
 * the selection comes from the git diff (see `selectChanged`).
 */
export function selectFiles(
  paths: string[],
  root = process.cwd(),
  options: SelectOptions = {},
): FileSelection {
  if (paths.length > 0) {
    // Naming files and asking for the diff are contradictory instructions,
    // and honouring the first while dropping the second silently is the
    // quiet no-op this tool exists to remove — the Ruby CLI's exact rule,
    // with its exact remediation sentence (cli.rb `select`).
    if (options.changed) {
      throw new LintUsageError(
        "--changed cannot be combined with explicit files; drop one " +
          "(named files are checked as given, --changed derives them from the diff)",
      );
    }
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
    return { files: [...paths], mode: "explicit", base: null, note: null, stats: null };
  }

  if (options.changed) return selectChanged(root, options.base);

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
  return { files, mode: "walk", base: null, note: null, stats: null };
}

/**
 * The `--changed` selection: annotated-source files changed against a diff
 * base, ported decision by decision from the Ruby client's `FileSelector`
 * (`specguard-rspec/lib/specguard/rspec/file_selector.rb`) — the code whose
 * measured defects this port exists to keep from being re-derived:
 *
 *   * The base is the **merge base with the default branch**, never bare
 *     `git diff --name-only`: that form compares working tree against index,
 *     which is EMPTY on a clean CI checkout — the silent zero-selection,
 *     exit-green-having-checked-nothing failure (SPGD-76).
 *   * Deleted paths are dropped at the git layer (`--diff-filter=d`) and the
 *     output is read NUL-separated (`-z`), so a path survives intact
 *     whatever characters it carries and a deletion can never be selected
 *     and then fail to open.
 *   * The selection is **cwd-scoped to match walk mode**: git's paths are
 *     repo-root-relative, so they are resolved against the toplevel and
 *     everything outside `root` is counted (`outsideRoot`) rather than
 *     silently taken — a thin selection must say it is thin because of the
 *     directory, not "nothing changed".
 *   * No default-branch ref but a HEAD: the diff base falls back to HEAD
 *     (uncommitted work only) and the degrade is DISCLOSED in the returned
 *     `note` — never silently.
 */
function selectChanged(root: string, explicitBase: string | undefined): FileSelection {
  if (!gitRepository(root)) {
    throw new LintUsageError(`--changed requires a git repository; ${root} is not inside one`);
  }

  const resolved = resolveDiffBase(explicitBase, root);
  if (resolved === null) {
    throw new LintUsageError(
      `--changed could not determine a diff base (no ${DEFAULT_BRANCH_REFS.join(", ")} ` +
        `and no HEAD commit); pass --changed=<base> explicitly`,
    );
  }

  const names = diffNames(resolved.base, root);
  const matches = names.filter(isAnnotatedSource);

  const top = topLevel(root);
  const topDir = top === "" ? root : top; // git could not say → the common case: root IS the top
  const rootReal = realPath(root);

  const files: string[] = [];
  let outsideRoot = 0;
  let unreadable = 0;
  for (const name of matches) {
    const absolute = path.join(topDir, name);
    const relative = path.relative(rootReal, absolute);
    const outside = relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative);
    if (outside) {
      outsideRoot += 1;
    } else if (!isFile(absolute)) {
      // Matched, in scope, and not there to open (a type change, a rename
      // source git still listed): counted, never selected — the same
      // partition the Ruby selector reports.
      unreadable += 1;
    } else {
      files.push(relative);
    }
  }
  files.sort();

  return {
    files,
    mode: "changed",
    base: resolved.base,
    note: baseNote(resolved.kind, resolved.base, root),
    stats: { changed: names.length, matches: matches.length, outsideRoot, unreadable },
  };
}

/** One git invocation, stderr captured (never inherited into our output),
 * every failure flattened to `ok: false` — each caller renders "git could
 * not answer" in its own vocabulary, exactly as the Ruby `git` helper does. */
function git(args: string[], root: string): { out: string; ok: boolean } {
  try {
    return {
      out: execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 16 * 1024 * 1024, // a name-only diff of a very large branch
      }),
      ok: true,
    };
  } catch {
    return { out: "", ok: false };
  }
}

function gitRepository(root: string): boolean {
  const run = git(["rev-parse", "--is-inside-work-tree"], root);
  return run.ok && run.out.trim() === "true";
}

/** The repository's top level — what `git diff`'s paths are relative to.
 * Empty when git cannot say; the caller falls back to root. */
function topLevel(root: string): string {
  const run = git(["rev-parse", "--show-toplevel"], root);
  return run.ok ? realPath(run.out.trim()) : "";
}

/** Symlink-resolved, so a root reached through a symlink still compares equal
 * to the physical path git reports. */
function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

type DiffBaseKind = "explicit" | "merge_base" | "head_fallback";

/** The diff base: the caller's `<base>` when given, else HEAD merged with the
 * first default-branch ref that resolves, else — no default ref anywhere —
 * HEAD itself with the `head_fallback` kind, else null (a repository with no
 * commits at all). */
function resolveDiffBase(
  explicitBase: string | undefined,
  root: string,
): { base: string; kind: DiffBaseKind } | null {
  if (explicitBase !== undefined) return { base: explicitBase, kind: "explicit" };

  const headRun = git(["rev-parse", "--verify", "--quiet", "HEAD"], root);
  const head = headRun.ok && headRun.out.trim() !== "" ? headRun.out.trim() : null;
  if (head === null) return null;

  for (const ref of DEFAULT_BRANCH_REFS) {
    const refRun = git(["rev-parse", "--verify", "--quiet", ref], root);
    if (!refRun.ok || refRun.out.trim() === "") continue;
    const mergeRun = git(["merge-base", "HEAD", ref], root);
    if (mergeRun.ok && mergeRun.out.trim() !== "") {
      return { base: mergeRun.out.trim(), kind: "merge_base" };
    }
  }

  // Detached from any known default branch: fall back to HEAD, which selects
  // uncommitted work only — better than selecting everything, PROVIDED the
  // degrade is said out loud (the note below).
  return { base: head, kind: "head_fallback" };
}

/** NUL-separated, deleted paths dropped — the machine-readable form: without
 * `-z`, `core.quotePath` renders a non-ASCII path quoted and byte-escaped,
 * which no longer names a file. */
function diffNames(base: string, root: string): string[] {
  const run = git(["diff", "-z", "--name-only", "--diff-filter=d", base, "--"], root);
  if (!run.ok) {
    throw new LintUsageError(`--changed could not diff against ${JSON.stringify(base)}`);
  }
  return run.out.split("\0").filter((name) => name !== "");
}

/** Explains a base that can only produce a thin selection, distinguishing the
 * two ways that happens: "this is a default-branch build" is normal, while
 * "no default ref could be found" means `--changed` quietly degraded to
 * diff-HEAD — reporting the first when the second is true would be a
 * confidently wrong explanation. */
function baseNote(kind: DiffBaseKind, base: string, root: string): string | null {
  if (kind === "head_fallback") {
    return (
      `no default-branch ref (${DEFAULT_BRANCH_REFS.join(", ")}) could be found, so the diff base ` +
      `fell back to HEAD; --changed can only select uncommitted changes here`
    );
  }
  if (kind === "merge_base") {
    const headRun = git(["rev-parse", "HEAD"], root);
    if (headRun.ok && headRun.out.trim() === base) {
      return (
        "the diff base is HEAD itself (this looks like a default-branch build), " +
        "so only uncommitted changes can be selected"
      );
    }
  }
  return null;
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
