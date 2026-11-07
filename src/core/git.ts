import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** One git invocation in `cwd`, stderr captured (never inherited into our
 * output), every failure flattened to `ok: false` — each caller renders "git
 * could not answer" in its own vocabulary. `timeoutMs` bounds the call for the
 * callers (the reporters) that must never hang a test run on a stuck git. */
export function git(
  args: string[],
  cwd: string,
  timeoutMs?: number,
): { out: string; ok: boolean } {
  try {
    return {
      out: execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 16 * 1024 * 1024, // a name-only diff of a very large branch
        ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
      }),
      ok: true,
    };
  } catch {
    return { out: "", ok: false };
  }
}

/** Symlink-resolved, so a root reached through a symlink still compares equal
 * to the physical path git reports. */
export function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** The repository's top level (symlink-resolved) — what `git diff`'s paths are
 * relative to. Empty when git cannot say; the caller falls back to `root`. */
export function gitTopLevel(root: string, timeoutMs?: number): string {
  const run = git(["rev-parse", "--show-toplevel"], root, timeoutMs);
  const top = run.ok ? run.out.trim() : "";
  return top === "" ? "" : realPath(top);
}
