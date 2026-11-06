import { isAbsolute, relative, sep } from "node:path";

/**
 * Repo-root-relative, POSIX-separated spelling of a runner-reported file path.
 *
 * - A non-absolute `file` gets only the separator fold to `/`.
 * - An absolute `file` is made relative to `repoRoot`. A file outside the root
 *   keeps its absolute path verbatim rather than a nonsense `../` escape;
 *   otherwise the separators are folded to `/`.
 */
export function repoRelativePosix(file: string, repoRoot: string): string {
  if (!isAbsolute(file)) return file.split(sep).join("/");
  const rel = relative(repoRoot, file);
  // A file outside the repo root keeps its absolute path rather than a
  // nonsense ../ escape.
  if (rel.startsWith("..") || isAbsolute(rel)) return file;
  return rel.split(sep).join("/");
}
