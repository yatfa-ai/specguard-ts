#!/usr/bin/env node
/**
 * `specguard` — the specguard-ts command line.
 *
 * Slice 3 ships `specguard lint`. Usage:
 *
 *   specguard lint [--json] [files...]
 *
 * Without paths, annotated source files (`.ts/.tsx/.js/.jsx/.mjs/.cjs`) are
 * discovered by walking the current directory. Exit codes: 0 clean (including
 * zero annotations), 1 malformed annotations, 2 could not do its job.
 */

import { lint } from "./lint/lint.js";
import { renderHuman, renderJson } from "./lint/report.js";

interface Options {
  json: boolean;
  help: boolean;
}

type Parsed = { options: Options; paths: string[] } | { error: string };

function usage(stream: NodeJS.WriteStream): void {
  stream.write("Usage: specguard lint [--json] [files...]\n");
}

function parse(argv: string[]): Parsed {
  const options: Options = { json: false, help: false };
  const paths: string[] = [];
  for (const arg of argv) {
    if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
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
  if (parsed.options.help) {
    usage(stdout);
    stdout.write("\nExit codes: 0 clean (including zero annotations), 1 malformed annotations, 2 could not lint.\n");
    return 0;
  }

  const report = lint(parsed.paths, { json: parsed.options.json });
  for (const line of report.stderr) stderr.write(`${line}\n`);
  if (report.exitCode !== 2 || report.findings.length > 0) {
    // Exit-2-with-no-findings runs emit no document (see report.ts); an
    // exit-2 WITH findings (unreadable files) still reports what it saw.
    stdout.write(parsed.options.json ? renderJson(report) : renderHuman(report));
  }
  return report.exitCode;
}

// Entry point when executed directly (bin). Importing for tests does nothing.
if (process.argv[1] !== undefined && process.argv[1].endsWith("cli.js")) {
  process.exit(run(process.argv.slice(2), process.stdout, process.stderr));
}
