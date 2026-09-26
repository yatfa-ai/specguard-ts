#!/usr/bin/env node
/**
 * `specguard` — the @yatfa/specguard command line.
 *
 * Slice 3 ships `specguard lint`. Usage:
 *
 *   specguard lint [--json] [--changed[=<base>]] [files...]
 *
 * Without paths, annotated source files (`.ts/.tsx/.js/.jsx/.mjs/.cjs`) are
 * discovered by walking the current directory; `--changed` instead selects
 * them from the git diff against the merge base with the default branch (or
 * an explicit `<base>`). Exit codes: 0 clean (including zero annotations),
 * 1 malformed or unreachable annotations, 2 could not do its job.
 *
 * `-v`/`--version` — bare or after `lint` — prints `specguard-ts <version>`
 * (one line, exit 0) before any discovery or scan.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EXIT_MISUSE, EXIT_OK, lint } from "./lint/lint.js";
import { renderHuman, renderJson } from "./lint/report.js";
import { version } from "./core/transport.js";

interface Options {
  json: boolean;
  help: boolean;
  version: boolean;
  changed: boolean;
  /** The explicit diff base of `--changed=<base>`; null means "derive it".
   * An explicit EMPTY base stays explicit (and fails loudly at the diff),
   * never silently re-read as "derive". */
  base: string | null;
}

type Parsed = { options: Options; paths: string[] } | { error: string };

function usage(stream: NodeJS.WriteStream): void {
  stream.write("Usage: specguard lint [--json] [--changed[=<base>]] [files...]\n");
}

function parse(argv: string[]): Parsed {
  const options: Options = { json: false, help: false, version: false, changed: false, base: null };
  const paths: string[] = [];
  for (const arg of argv) {
    if (arg === "--json") options.json = true;
    else if (arg === "--changed") options.changed = true;
    else if (arg.startsWith("--changed=")) {
      options.changed = true;
      options.base = arg.slice("--changed=".length);
    } else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--version" || arg === "-v") options.version = true;
    else if (arg.startsWith("--")) return { error: `invalid option: ${arg}` };
    else paths.push(arg);
  }
  return { options, paths };
}

export function run(argv: string[], stdout: NodeJS.WriteStream, stderr: NodeJS.WriteStream): number {
  const subcommand = argv[0];

  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    usage(subcommand === undefined ? stdout : stderr);
    if (subcommand === undefined) {
      stdout.write("\nCommands: lint\n");
    } else {
      stdout.write("\nCommands: lint\n");
    }
    return subcommand === undefined ? 2 : 0;
  }

  if (subcommand === "--version" || subcommand === "-v") {
    // The identity query: one line, exit 0, before any discovery or scan —
    // the same contract the Ruby client's `-v, --version` option honors
    // (cli.rb prints `specguard-ruby #{VERSION}` and returns before scanning).
    stdout.write(`specguard-ts ${version()}\n`);
    return EXIT_OK;
  }

  if (subcommand !== "lint") {
    stderr.write(`specguard: error: unknown command: ${subcommand}\n`);
    usage(stderr);
    return 2;
  }

  const parsed = parse(argv.slice(1));
  if ("error" in parsed) {
    stderr.write(`specguard lint: error: ${parsed.error}\n`);
    return 2;
  }
  if (parsed.options.version) {
    // The identity query again, at lint level: one line, exit 0, before any
    // discovery or scan (the Ruby suite pins that a version-only run scans
    // nothing on its way to the exit).
    stdout.write(`specguard-ts ${version()}\n`);
    return EXIT_OK;
  }
  if (parsed.options.help) {
    usage(stdout);
    stdout.write(
      "\n  -v, --version       print the version and exit\n" +
        "  --changed[=<base>]  check only files changed against <base> (default: the\n" +
        "                      merge base with the default branch; never a bare\n" +
        "                      working-tree-vs-index diff, which is empty in CI).\n" +
        "                      Untracked files are selected too, so a brand-new\n" +
        "                      file that has not been git-added is still checked\n" +
        "                      (.gitignore keeps paths out of that untracked leg\n" +
        "                      only; a tracked file is never ignored). Either leg\n" +
        "                      skips the fixed dependency/build directories\n" +
        "                      (node_modules, .git, dist, .test-build, coverage).\n",
    );
    stdout.write("\nExit codes: 0 clean (including zero annotations), 1 malformed or unreachable annotations, 2 could not lint.\n");
    return 0;
  }

  try {
    const report = lint(parsed.paths, {
      json: parsed.options.json,
      changed: parsed.options.changed,
      base: parsed.options.base ?? undefined,
    });
    for (const line of report.stderr) stderr.write(`${line}\n`);
    if (report.exitCode !== 2 || report.findings.length > 0) {
      // Exit-2-with-no-findings runs emit no document (see report.ts); an
      // exit-2 WITH findings (unreadable files) still reports what it saw.
      stdout.write(parsed.options.json ? renderJson(report) : renderHuman(report));
    }
    return report.exitCode;
  } catch (error) {
    // The boundary of the exit contract: lint() deliberately re-throws
    // anything that is not a typed verdict, and an uncaught throw here would
    // die as Node's uncaught-exception default — exit 1, which the contract
    // defines as "malformed or unreachable annotations". A crashed run must
    // never wear that
    // verdict (the SPGD-1121 crash escaped exactly this way), so the
    // boundary catches it: one stderr line, exit 2, no document.
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`specguard lint: internal error: ${message}\n`);
    return EXIT_MISUSE;
  }
}

/**
 * Is this module the process entry point? The ESM stand-in for
 * `require.main === module`, and it MUST compare real paths.
 *
 * npm installs a bin as a symlink — `node_modules/.bin/specguard ->
 * ../@yatfa/specguard/dist/cli.js` — and Node does NOT resolve it for
 * `process.argv[1]`: the entry point reports the LINK's own path, which ends
 * in the bin's name and not in this file's name. A guard that compared
 * filename suffixes therefore read false for every installed consumer, so the
 * bin loaded, ran nothing and exited 0 — a silent no-op rather than anything
 * diagnosable, and invisible to a test that invokes the file by path.
 * `realpathSync` on both sides makes the link and its target the same file.
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

// Entry point when executed directly (bin). Importing for tests does nothing.
if (isEntryPoint()) {
  process.exit(run(process.argv.slice(2), process.stdout, process.stderr));
}
