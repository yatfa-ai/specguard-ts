import type { LintReport } from "./lint.js";
import type { FileSelection } from "./discover.js";

/**
 * Two renderers over ONE report, mirroring the Ruby client's `--json`
 * decision: `--json` replaces the stdout report; it never touches the exit
 * code (already decided in lint.ts). The renderers write no stderr of their
 * own — diagnostics about the linter live there (SPGD-247) — but the
 * selection sentence is BOTH renderers' line, one stream each (SPGD-1144):
 * the human report reads it on stdout, json mode carries the same bytes on
 * stderr (emitted by lint.ts, beside the note warnings) so the selection
 * stays machine-verifiable. No exit-2 path emits a document — a run that
 * checked nothing must not dress "could not check" as structure.
 */

function location(f: { file: string; line: number | null }): string {
  return f.line !== null ? `${f.file}:${f.line}` : f.file;
}

/**
 * The provenance sentence for a run's file count, built at exactly one site
 * and written by both renderers — only the stream differs (SPGD-1144). The
 * human report reads it as its first stdout line; under `--json` the document
 * REPLACES the human report, so the sentence would be constructed by no code
 * path at all, and lint.ts carries the same bytes on stderr instead — where
 * the linter's own diagnostics already live, and which the bridge forwards
 * verbatim as `linter_stderr`. One builder is what makes "the machine reads
 * the provenance the human does" a property of the code rather than a
 * promise two copies could drift apart on.
 */
export function provenanceLine(files: number, selection: FileSelection | null): string {
  const changedSince =
    selection?.mode === "changed" && selection.base !== null
      ? ` changed since ${selection.base}`
      : "";
  // The `--changed` count names its provenance: files can reach the selection
  // through the untracked leg (`discover.ts`), and "changed since <base>"
  // alone over-claims for a file the diff never saw. When the untracked leg
  // contributed, the line says how many — the same `stats.untracked` the
  // selection carries, so the clause can only ever name files this run
  // actually checked.
  const untrackedClause =
    selection?.mode === "changed" && (selection.stats?.untracked ?? 0) > 0
      ? ` including ${selection.stats?.untracked} untracked`
      : "";
  return (
    `specguard lint: checked ${files} source file${files === 1 ? "" : "s"}` +
    changedSince + untrackedClause
  );
}

/** The human-readable stdout report. */
export function renderHuman(report: LintReport): string {
  const lines: string[] = [provenanceLine(report.summary.files, report.selection)];

  for (const finding of report.findings) {
    if (finding.ok) continue; // passing annotations are counted, not listed
    lines.push(`FAIL ${location(finding)} (${finding.kind})`);
    for (const error of finding.errors) lines.push(`  - ${error}`);
  }

  const parts = [`${report.summary.annotations} annotation${report.summary.annotations === 1 ? "" : "s"}`];
  if (report.summary.malformed > 0) parts.push(`${report.summary.malformed} malformed`);
  if (report.summary.unreadable > 0) parts.push(`${report.summary.unreadable} unreadable`);
  lines.push(`specguard lint: ${parts.join(", ")}`);

  if (report.backendNote !== null) lines.push(`specguard lint: ${report.backendNote}`);
  return lines.join("\n") + "\n";
}

/** The machine-readable `--json` stdout document, mirroring the binary's finding shape. */
export function renderJson(report: LintReport): string {
  const document: Record<string, unknown> = {
    mode: "source",
    ok: report.ok,
    backend: report.backend,
    summary: report.summary,
    findings: report.findings.map((f) => ({
      file: f.file,
      line: f.line,
      kind: f.kind,
      ok: f.ok,
      errors: f.errors,
    })),
  };
  const selection = report.selection;
  if (selection?.mode === "changed" && selection.base !== null) {
    // The selection provenance, disclosed only for the runs where the diff
    // chose the files — the SPGD-858 disclosure, so a thin selection is
    // never confidently mis-attributed to the walk. Walk/explicit documents
    // carry no selection block, byte-identical to their previous shape.
    document.selection = { mode: "changed", base: selection.base, note: selection.note };
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}
