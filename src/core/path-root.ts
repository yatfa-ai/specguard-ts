import path from "node:path";
import { gitTopLevel, realPath } from "./git.js";

/** Upper bound on the one git probe a run makes; a stuck git must not hang a test run. */
const PROBE_TIMEOUT_MS = 2000;

/**
 * The two roots a reporter run needs, kept apart on purpose.
 *
 * - `pathRoot` is what `file_path` and annotation keys are made relative to.
 *   By default it is the git toplevel, so two workspace packages of one
 *   monorepo cannot ship the same `src/util.test.js` for different files.
 * - `walkRoot` is where annotation discovery scans for `@intent:` sources. It
 *   stays the working directory, so a run from `packages/a` never walks the
 *   whole monorepo.
 */
export interface RunRoots {
  pathRoot: string;
  walkRoot: string;
}

/**
 * Resolve both roots ONCE, at run start; thread the result through the run.
 *
 * An explicit `repoRoot` wins and serves both purposes (the long-standing
 * `options.repoRoot` contract). Otherwise `walkRoot` is `cwd` and `pathRoot`
 * is the git toplevel of `cwd` — falling back to `cwd` itself when git is
 * absent, `cwd` is not in a repository, or the answer does not contain `cwd`,
 * which keeps non-git and repo-root runs byte-identical to cwd-relative
 * behavior. A nested repository or submodule as `cwd` resolves to its own
 * toplevel. Never throws.
 */
export function resolveRunRoots(explicitRoot?: string, cwd: string = process.cwd()): RunRoots {
  if (explicitRoot !== undefined) return { pathRoot: explicitRoot, walkRoot: explicitRoot };
  return { pathRoot: gitPathRoot(cwd), walkRoot: cwd };
}

function gitPathRoot(cwd: string): string {
  try {
    const top = gitTopLevel(cwd, PROBE_TIMEOUT_MS);
    if (top === "") return cwd;
    const rel = path.relative(top, realPath(cwd));
    if (rel.startsWith("..") || path.isAbsolute(rel)) return cwd;
    // `top` is the symlink-resolved physical path; when `cwd` is already
    // physical (the usual case) they agree, otherwise keep the physical spelling
    // since runners report physical file paths.
    return top;
  } catch {
    return cwd;
  }
}
