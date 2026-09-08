import type { LintReport } from "./lint.js";

/**
 * Two renderers over ONE report, mirroring the Ruby client's `--json`
 * decision: `--json` replaces the stdout report; it never touches the exit
 * code (already decided in lint.ts) or stderr (diagnostics about the linter,
 * not findings). No exit-2 path emits a document — a run that checked
 * nothing must not dress "could not check" as structure.
 */

function location(f: { file: string; line: number | null }): string {
  return f.line !== null ? `${f.file}:${f.line}` : f.file;
}

/** The human-readable stdout report. */
export function renderHuman(report: LintReport): string {
  const lines: string[] = [];
  const selection = report.selection;
  const changedSince =
    selection?.mode === "changed" && selection.base !== null
      ? ` changed since ${selection.base}`
      : "";
  lines.push(
    `specguard lint: checked ${report.summary.files} source file${report.summary.files === 1 ? "" : "s"}` +
      changedSince,
  );

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
