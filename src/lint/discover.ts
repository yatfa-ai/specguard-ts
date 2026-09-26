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
 * `Stats`, carried for the same reason it is there. The exception is
 * `untracked`, which filters nothing: it counts the selected files that
 * arrived via the untracked leg, so the report can say where a file the diff
 * never saw came from (an untracked file outside `root` is counted in
 * `outsideRoot`, not here — this names files the run checked).
 */
export interface ChangedStats {
  /** Paths the diff named plus the untracked leg's paths (deleted paths
   * never arrive — see `diffNames`). */
  changed: number;
  /** Of those, the ones matching the annotated extensions. */
  matches: number;
  /** Matched files that live outside the selection root (the cwd). */
  outsideRoot: number;
  /** Matched, in-root paths that are not existing regular files. */
  unreadable: number;
  /** Selected files that arrived via the untracked leg — never a diff path,
   * so the legs cannot double-count. Additive with a default of 0, the same
   * shape the Ruby client's SPGD-1119 fix gave its `Stats`. */
  untracked: number;
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
  /** How many matched files the `SKIPPED_DIRECTORIES` fence removed from this
   * selection — `changed` mode's count over the diff+untracked union (see
   * `selectChanged`). 0 in the other modes: the walk fences at the directory
   * entry during recursion (so it never counts a file-level removal) and an
   * explicit list is checked as given, bypassing the fence entirely. A fence
   * that removes files must say so — this count is what the report's
   * disclosure clause reads, so the narrowing is never silent. */
  skipped: number;
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

/**
 * Why a scan could not look at a file — the two facts SPGD-1006 found riding
 * one flag:
 *   * "unreadable": the read itself failed. Nobody can look at this file —
 *     the validate-intent binary will fail on it too.
 *   * "oversize": the file exceeds this client's SCAN_MAX_BYTES token-scan
 *     budget. A client-side verdict only; the binary has no size cap and
 *     reads the file fine.
 */
export type UnscannableReason = "unreadable" | "oversize";

export interface FileScan {
  file: string;
  /** Token occurrences on any line — a gate count, never a verdict. */
  tokens: number;
  /** True when the file could not be scanned at all (unreadable, or over
   * SCAN_MAX_BYTES) — a `tokens: 0` on such a file means "could not look",
   * never "looked and found nothing". */
  unscannable: boolean;
  /** Which of the two "could not look" facts holds (SPGD-1006). Null when
   * `unscannable` is false. Consumers split on this: a "could not look"
   * gate must not be laundered into "nothing to check", so it reads
   * `unscannable` — but a "ships unannotated" claim must name ONLY
   * `unreadable` files. An oversize file is read and ratified by the
   * size-cap-free binary, so its rows annotate; naming it as unannotated
   * would call this same pass's annotated rows unannotated. */
  unscannableReason: UnscannableReason | null;
}

export class LintUsageError extends Error {}

function isAnnotatedSource(file: string): boolean {
  const ext = path.extname(file).toLowerCase();
  return (ANNOTATED_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * Whether a root-relative path runs through a `SKIPPED_DIRECTORIES`
 * directory. Whole segments only — `path.sep`-delimited — so a directory
 * merely *named after* a fenced word (`src/dist_helpers/`) is project code,
 * not fenced, and the basename is excluded from the segment set: a path's
 * last component is the file itself, so `src/coverage.ts` is selected
 * whatever its name contains. The same grain the Ruby twin's
 * `skipped_directory?` decides at (`file_selector.rb`), and a different
 * shape from `walk()`'s application of the same set: the walk fences at the
 * directory entry during recursion, while `--changed` receives paths from
 * git and must decide on the root-relative path — this predicate is the
 * set's second application site, and the first path-level one.
 */
function skippedDirectory(relative: string): boolean {
  const segments = relative.split(path.sep);
  segments.pop();
  return segments.some((segment) => SKIPPED_DIRECTORIES.has(segment));
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
      // The directory question is asked FIRST, and the order is the whole
      // point: `path.extname` of an ordinary directory is `""`, so an
      // extension pre-check answers `src` with "not an annotated source
      // file" — false, and it sends the user after an extension when the
      // remedy is "name files or run without paths". The Ruby twin refuses
      // directories at this branch with this same sentence and carries no
      // suffix pre-check at all (`cli.rb` `select`); this is that shape.
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(p);
      } catch {
        // A nonexistent or unreadable named path is the BINARY's read
        // finding, not ours — so it is not a directory refusal. It must
        // still FALL THROUGH to the extension guard below rather than skip
        // the iteration: `lint nonexistent.md` is a usage error about the
        // extension whether or not the path resolves, and a `continue` here
        // would silently drop that answer.
        stat = null;
      }
      if (stat?.isDirectory()) {
        throw new LintUsageError(`${p} is a directory; name files or run without paths`);
      }
      if (!isAnnotatedSource(p)) {
        throw new LintUsageError(
          `${p} is not an annotated source file (${ANNOTATED_EXTENSIONS.join(", ")})`,
        );
      }
    }
    return { files: [...paths], mode: "explicit", base: null, note: null, stats: null, skipped: 0 };
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
  return { files, mode: "walk", base: null, note: null, stats: null, skipped: 0 };
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
 *   * The name set is a **union**: the diff's paths plus ONE `git ls-files
 *     --others --exclude-standard -z` call per selection, run at the toplevel
 *     so its repo-root-relative output flows through the same scoping as the
 *     diff's (from a subdirectory `ls-files` emits cwd-relative paths, which
 *     would defeat it). A brand-new file that has never been `git add`ed is
 *     part of "what changed against <base>, whether or not the change is
 *     committed yet" — the mode's own promise — and a diff-only name set
 *     would ride it past the gate behind a non-empty checked-count in the
 *     mixed shape every real working tree has. `--exclude-standard` is the
 *     untracked leg's boundary: `.gitignore`d paths never enter through it.
 *     It is a second removal, never the selection's only fence: ignored
 *     *tracked* paths still arrive on the diff leg (git never applies ignore
 *     rules to tracked files), which is why the `SKIPPED_DIRECTORIES` fence
 *     applies to the union as a whole. The legs are
 *     disjoint by construction (an untracked path is never a diff path), so
 *     the union cannot double-count and needs no dedup. No history is
 *     consulted, so the leg works in a shallow clone, and a failed call
 *     degrades to an empty leg rather than killing a run the tracked diff
 *     already serves. The union is built with `concat`, never spread — see
 *     `changedNameUnion`: selection must hold at any untracked-leg size.
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

  // One memoized probe per run, shared by the two message branches that
  // consult it (a failed diff, a thin base note).
  const isShallow = shallowProbe(root);

  // Each name is tagged with its leg so `stats.untracked` can attribute the
  // selected files the diff never saw. The legs are disjoint by construction
  // (an untracked path is never a diff path), so the plain union cannot
  // double-count and needs no dedup.
  const diffLeg = diffNames(resolved.base, root, isShallow);

  const top = topLevel(root);
  const topDir = top === "" ? root : top; // git could not say → the common case: root IS the top
  const names = changedNameUnion(diffLeg, untrackedLegNames(topDir));

  const matches = names.filter(({ name }) => isAnnotatedSource(name));
  const rootReal = realPath(root);

  const files: string[] = [];
  let outsideRoot = 0;
  let unreadable = 0;
  let untracked = 0;
  let skipped = 0;
  for (const { name, untracked: fromUntrackedLeg } of matches) {
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
    } else if (skippedDirectory(relative)) {
      // The same SKIPPED_DIRECTORIES fence walk() applies, decided on the
      // root-relative path at the same segment grain. It sits after the
      // scoping arms so it counts a different exclusion and never perturbs
      // `outsideRoot`/`unreadable`; because the union is already materialized
      // here, one placement covers BOTH legs — the diff leg (where
      // `.gitignore` cannot act, git never applies ignore rules to tracked
      // files) and the untracked leg on a repository that does not ignore
      // its vendored tree. The count rides `FileSelection.skipped` so the
      // report can disclose the narrowing instead of doing it silently.
      skipped += 1;
    } else {
      files.push(relative);
      if (fromUntrackedLeg) untracked += 1;
    }
  }
  files.sort();

  return {
    files,
    mode: "changed",
    base: resolved.base,
    note: baseNote(resolved.kind, resolved.base, root, isShallow),
    stats: {
      changed: names.length,
      matches: matches.length,
      outsideRoot,
      unreadable,
      untracked,
    },
    skipped,
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
function diffNames(base: string, root: string, isShallow: () => boolean): string[] {
  const run = git(["diff", "-z", "--name-only", "--diff-filter=d", base, "--"], root);
  if (!run.ok) {
    if (isShallow()) {
      // SPGD-1027: in a shallow checkout the overwhelmingly likely cause is
      // that <base> is simply not in the clone's history (git's own stderr
      // says `fatal: bad object`), and the fix is a fetch — a cause the bare
      // message never named, leaving "bad ref" and "shallow history"
      // indistinguishable. Non-shallow failures keep the original message.
      throw new LintUsageError(
        `--changed could not diff against ${JSON.stringify(base)}: this checkout is shallow and ` +
          `${JSON.stringify(base)} is not in its history — fetch it (fetch-depth: 0, or ` +
          `git fetch origin ${base}) or pass a base the checkout contains`,
      );
    }
    throw new LintUsageError(`--changed could not diff against ${JSON.stringify(base)}`);
  }
  return run.out.split("\0").filter((name) => name !== "");
}

/** The untracked leg of the `--changed` name set: `git ls-files --others
 * --exclude-standard -z`, run at the toplevel so its repo-root-relative
 * output shares the diff leg's coordinate space. `--exclude-standard` is the
 * untracked leg's `.gitignore` boundary (scratch directories, vendored code,
 * build output never enter through it) — a second removal beside the
 * `SKIPPED_DIRECTORIES` fence the selection loop applies to the union, never
 * a substitute for it: a tracked file is never subject to `.gitignore`, so
 * the diff leg arrives unfenced by this flag whatever it ignores;
 * `-z` for the same quotePath reasons as the
 * diff leg; no history is consulted, so the leg works in a shallow clone. A
 * failed call degrades to an empty leg rather than killing a run the tracked
 * diff already serves — git says nothing, so the union is the diff alone. */
function untrackedLegNames(root: string): string[] {
  const run = git(["ls-files", "--others", "--exclude-standard", "-z"], root);
  return run.ok ? run.out.split("\0").filter((name) => name !== "") : [];
}

/** The changed-mode name set: the diff leg first, then the untracked leg,
 * each tagged with its origin. Built with `concat`, never with a spread over
 * a leg: `push(...leg)` is call-stack-bound and throws `RangeError: Maximum
 * call stack size exceeded` once a leg outgrows Node's spread-argument
 * budget — and a large untracked leg is a real shape, an early-stage
 * repository whose `.gitignore` does not yet cover `node_modules` hands the
 * untracked leg hundreds of thousands of entries. A crash there would die in
 * selection, before the validator ran, and exit non-zero on empty output,
 * which the exit contract reads as malformed (or unreachable) annotations.
 * `concat` iterates
 * instead of putting the leg on the call stack, so the union holds at any
 * leg length. */
export function changedNameUnion(
  diffLeg: string[],
  untrackedLeg: string[],
): { name: string; untracked: boolean }[] {
  let names = diffLeg.map((name) => ({ name, untracked: false }));
  names = names.concat(untrackedLeg.map((name) => ({ name, untracked: true })));
  return names;
}

/** Memoized per-run `git rev-parse --is-shallow-repository` probe. SPGD-1027:
 * shallowness is consulted only in the branches where it changes the message
 * (a derived base of HEAD, a failed diff), so the full-clone happy path makes
 * zero new git invocations and the memo caps the probe at one per run. An
 * unreadable answer (old git without the flag) reads as not shallow, keeping
 * today's messages exactly. */
function shallowProbe(root: string): () => boolean {
  let cached: boolean | null = null;
  return () => {
    if (cached === null) {
      const run = git(["rev-parse", "--is-shallow-repository"], root);
      cached = run.ok && run.out.trim() === "true";
    }
    return cached;
  };
}

/** Explains a base that can only produce a thin selection, distinguishing the
 * two ways that happens: "this is a default-branch build" is normal, while
 * "no default ref could be found" means `--changed` quietly degraded to
 * diff-HEAD — reporting the first when the second is true would be a
 * confidently wrong explanation.
 *
 * SPGD-1027: a shallow (depth-limited) checkout reproduces both thin shapes
 * with a third cause those two stories miss — the merge base with the default
 * branch is not in the clone's history at all — so whenever the repo IS
 * shallow the note tells that story and names the remedy (fetch the default
 * branch, or pass a base the checkout contains), retiring the
 * "default-branch build" guess for shallow repos in both shapes. */
function baseNote(
  kind: DiffBaseKind,
  base: string,
  root: string,
  isShallow: () => boolean,
): string | null {
  const shallowRemedy =
    "fetch the default branch (fetch-depth: 0) or pass --changed=<base> naming a base this checkout contains";
  if (kind === "head_fallback") {
    if (isShallow()) {
      return (
        "this checkout is a shallow (depth-limited) clone and no default-branch ref " +
        `(${DEFAULT_BRANCH_REFS.join(", ")}) is in its history, so the diff base fell back to ` +
        `HEAD; --changed can only select uncommitted changes here — ${shallowRemedy}`
      );
    }
    return (
      `no default-branch ref (${DEFAULT_BRANCH_REFS.join(", ")}) could be found, so the diff base ` +
      `fell back to HEAD; --changed can only select uncommitted changes here`
    );
  }
  if (kind === "merge_base") {
    const headRun = git(["rev-parse", "HEAD"], root);
    if (headRun.ok && headRun.out.trim() === base) {
      if (isShallow()) {
        return (
          "this checkout is a shallow (depth-limited) clone, so the merge base with the default " +
          "branch is not in its history and the diff base is HEAD itself — only uncommitted " +
          `changes can be selected; ${shallowRemedy}`
        );
      }
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
 *
 * SPGD-1006: the flag's two causes are also told apart (`unscannableReason`)
 * because they do not license the same downstream claim. "Unreadable" is a
 * fact about the file; "oversize" is a fact about THIS client's scan budget,
 * and the size-cap-free binary ratifies oversize files normally — so a
 * consumer asserting "these files ship unannotated" must select on the
 * reason, never on the bare flag.
 */
export function scanTokens(files: string[]): FileScan[] {
  return files.map((file) => {
    let text: string;
    try {
      const buf = fs.readFileSync(file);
      if (buf.byteLength > SCAN_MAX_BYTES) {
        return { file, tokens: 0, unscannable: true, unscannableReason: "oversize" };
      }
      text = buf.toString("utf8");
    } catch {
      return { file, tokens: 0, unscannable: true, unscannableReason: "unreadable" };
    }
    let tokens = 0;
    let at = text.indexOf(INTENT_TOKEN);
    while (at !== -1) {
      tokens += 1;
      at = text.indexOf(INTENT_TOKEN, at + INTENT_TOKEN.length);
    }
    return { file, tokens, unscannable: false, unscannableReason: null };
  });
}
