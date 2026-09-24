import type { Drained, Folding, LineResult, ListedLine, Source, StatusCounts } from "./ingest-cli.js";

/**
 * `specguard-ingest --json`: the machine-readable renderer over the same
 * per-line facts the human report is built from.
 *
 * A port of the Ruby client's `SpecGuard::RSpec::IngestReporter`
 * (`lib/specguard/rspec/ingest_reporter.rb`) — the document shape is that
 * file's, key for key: two clients emitting differently-shaped documents for
 * one command is the defect parity exists to prevent.
 *
 * == Why a second renderer, on the one command that most needed it
 *
 * An HTTP 400 is the only *permanent* verdict in this command's contract
 * (`CONTENT_REFUSAL_CODES`) — a refused line is refused every time it is
 * offered — so the only way to land the run is to learn which specs the
 * platform objected to and fix the payload. The platform sends one error per
 * offending spec, and the refusal parse (`transport.ts`'s `refusalReasons`)
 * keeps the whole array. The human line flattens it — whitespace collapsed,
 * hard-truncated at 300 characters — because it is built for the **one stderr
 * line an in-run CI warning is allowed**. That cap is right where it was set
 * and is not touched here. It is a cap on a *line*, and this document is not
 * a line: `specguard-ingest` already prints a row per line, a summary and its
 * folding observations, out of band and nowhere near a CI log. So the
 * refusal's own grounds do not reach a second channel, and this is that
 * channel — the command whose entire job is to fix and re-send a refused run
 * can now show you all of why it was refused.
 *
 * This is a RENDERER: it reads the `LineResult`s the delivery already
 * produced and the `ListedLine`s the listing already extracted, and decides
 * nothing. The exit code, the statuses, the selection and the cap are all
 * upstream of here and identical on both paths.
 *
 * == Why the document does NOT carry `ok` or `exit_code`
 *
 * Deliberately. This command's verdict is not a boolean: 0, 1 and 2 mean
 * "accepted", "the platform refused content" and "this tool could not do its
 * job", and collapsing that to a boolean would have to pick which of 1 and 2
 * counts as false. Restating the integer here would be a second copy of a
 * fact the process already exits with, free to drift from it. So the exit
 * status stays the one carrier of the verdict, unchanged by the flag, and the
 * document carries the facts it is computed from.
 *
 * == Which runs emit a document
 *
 * By cause, not by exit code. A run that got as far as reading <file> emits a
 * document, whatever its exit code and even when the file held nothing to
 * deliver (`"lines": []` next to a `summary` of zeroes is a true statement
 * about an empty file, and the warning naming *why* it was empty is on stderr
 * either way). A run that never got that far — a bad flag, `--from-line` with
 * `--lines`, no endpoint or API key, a file that cannot be read — emits prose
 * on stderr and nothing at all on stdout, because there is nothing yet to be
 * a document about.
 *
 * == The counts are handed in, not recomputed
 *
 * `summary`'s status counts are the ones `ingest-cli.ts` computes once for
 * whichever renderer runs: two renderers of one result list that can disagree
 * about how much of a file was delivered are worse than prose alone, because
 * the disagreement is unfalsifiable from outside the process. The folding
 * observations are the same shape of thing — one grouping, rendered here as
 * data and there as a sentence.
 */

/** What wrote the document. Not a schema id — see the module comment. */
const TOOL = "specguard-ingest";

/** Whether lines were sent or only shown — the distinction a consumer most needs. */
const MODE_DELIVER = "deliver";
const MODE_LIST = "list";

/**
 * A listed line that is a run, and one that is not. The delivery-side
 * statuses are rendered by their vocabulary key (`undelivered`, not the prose
 * renderer's `not delivered`) so a consumer branches on the tool's vocabulary
 * rather than on its wording.
 */
const STATUS_LISTED = "listed";
const STATUS_UNPARSEABLE = "unparseable";

/** One document per delivery run — the rows the delivery produced. */
export function renderDelivery(args: {
  source: Source;
  results: LineResult[];
  counts: StatusCounts;
  foldings: Folding[];
  drained: Drained | null;
}): string {
  const { source, results, counts, foldings, drained } = args;
  return document(
    MODE_DELIVER,
    source,
    results.map((result) => delivered(result)),
    summary(source, results.length, counts, attempted(counts), drained),
    foldings.map((folding) => folded(folding)),
  );
}

/** One document per listing — the envelope facts the text rows print, as values. */
export function renderListing(args: {
  source: Source;
  lines: ListedLine[];
  counts: StatusCounts;
}): string {
  const { source, lines, counts } = args;
  // Every delivery count is 0 and `attempted` is 0, which is this document's
  // way of saying what the text listing says in words: nothing was delivered.
  // `unparseable` is the one that can be positive, because a line that is not
  // a run is knowable without sending it.
  return document(
    MODE_LIST,
    source,
    lines.map((line) => listed(line)),
    summary(source, lines.length, counts, 0, null),
    [],
  );
}

function document(
  mode: string,
  source: Source,
  lines: unknown[],
  summary: Record<string, unknown>,
  foldings: unknown[],
): string {
  return `${JSON.stringify(
    {
      tool: TOOL,
      mode,
      file: source.path,
      summary,
      lines,
      foldings,
    },
    null,
    2,
  )}\n`;
}

/**
 * `lines` is the rows in this document; `attempted` is how many of them were
 * offered to the endpoint. The pair is what keeps the four status counts
 * readable: three zeroes under `"mode": "list"` mean "nothing was sent", and
 * the same three under a delivery of 40 lines would mean something very
 * different.
 *
 * `blank` and `skipped` are the two ways a line of <file> is not a row here.
 * They are stated always: a summary that quietly narrows what it is
 * summarising is the failure this command is arranged against.
 *
 * `absent` is that same rule pointed the other way — at the numbers that were
 * typed rather than at the lines that were read. A `--lines` entry naming past
 * the end of the file is held back by nothing and read as nothing, so
 * `skipped` (which counts lines of <file>) structurally cannot carry it, and
 * without this key a satisfied selector and a phantom one render the identical
 * document. It is `null` rather than `[]` where the selector was fully
 * satisfied, on `selector`'s terms: a fact that does not apply is absent,
 * never a fabricated empty.
 *
 * `drained` is the `--drain` count, and it is present exactly when the flag
 * was given — `0` where the flag asked and nothing was accepted, so a consumer
 * that asked for the drain can always read its outcome here, and a document
 * without the key is a run that never asked. The listing never carries it:
 * `--drain --list` is refused before either renderer runs.
 */
function summary(
  source: Source,
  lines: number,
  counts: StatusCounts,
  attempted: number,
  drained: Drained | null,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    lines,
    attempted,
    accepted: counts.accepted,
    refused: counts.refused,
    undelivered: counts.undelivered,
    unparseable: counts.unparseable,
    blank: source.blank,
    skipped: source.skipped,
    absent: absent(source),
    selector: selector(source),
  };
  // The count of removed lines, and only that — the Ruby twin's document is
  // the shape of record here, key for key, and its `summary.drained` is the
  // integer (`renderDelivery`'s port note above: two clients emitting
  // differently-shaped documents for one command is the defect parity exists
  // to prevent). Whether a rewrite happened at all and how many lines it
  // left are stated by the human renderer's clause; failed runs shout on
  // stderr and through the exit code.
  if (drained !== null) result["drained"] = drained.removed;
  return result;
}

/**
 * The typed line numbers the file does not have, in the shorthand they were
 * typed in and computed by `readSource` once for both renderers — the
 * discipline the counts above are held to, applied to the one fact the text
 * summary and this document could otherwise disagree about.
 *
 * `null` rather than `[]` where the selector was fully satisfied, on
 * {@link selector}'s terms: a fact that does not apply is absent, never a
 * fabricated empty.
 */
function absent(source: Source): string[] | null {
  return source.absent.length === 0 ? null : source.absent;
}

/** Every line that reached the endpoint, which is every line except the ones that were never a run. */
function attempted(counts: StatusCounts): number {
  return counts.accepted + counts.refused + counts.undelivered;
}

/**
 * Which flag held lines back, named on exactly the terms the text summary
 * names it: only when it demonstrably held something back. `--from-line`
 * defaults to 1 when it was not given at all, so reporting it unconditionally
 * would claim a selector the user never typed.
 */
function selector(source: Source): string | null {
  if (source.skipped <= 0) return null;
  return source.selector === "lines" ? "--lines" : "--from-line";
}

/**
 * One delivered line.
 *
 * `code` is the HTTP status, and `null` where there is not one: a line that
 * was never a run, and a delivery that never got an answer at all (connection
 * refused, DNS, TLS, a timeout). Together with `status` it is what tells the
 * two apart from a refusal, which is why `reasons` can collapse all three
 * into one list.
 */
function delivered(result: LineResult): Record<string, unknown> {
  return {
    number: result.number,
    status: result.status,
    code: result.code,
    reasons: reasons(result.reasons),
    test_run_id: result.testRunId,
    ci_run_id: result.ciRunId,
  };
}

/**
 * One listed line: the envelope facts the text row prints, as values rather
 * than as prose. `null` is the row's `no branch` / `no specs` /
 * `no duration_seconds` — a fact the line does not carry, which is a
 * different thing from one it carries as empty.
 */
function listed(line: ListedLine): Record<string, unknown> {
  return {
    number: line.number,
    status: line.problem !== null ? STATUS_UNPARSEABLE : STATUS_LISTED,
    reasons: reasons(line.problem),
    branch: line.branch,
    commit_sha: line.commitSha,
    ci_run_id: line.ciRunId,
    examples: line.examples,
    duration_seconds: line.durationSeconds,
  };
}

function folded(folding: Folding): Record<string, unknown> {
  return {
    ci_run_id: folding.ciRunId,
    test_run_id: folding.testRunId,
    lines: folding.numbers,
  };
}

/**
 * ALWAYS a list of strings — `[]` where the line landed and where a refusal's
 * body said nothing this client could read, never `null` and never a bare
 * string. A consumer must never have to branch on the type of the field that
 * says why something failed; one list is what lets a refusal's per-spec
 * errors, a socket error and "this line is not a run" be read by one code
 * path.
 *
 * The whole array, uncapped — that is the point of the document. It is what
 * the platform sent, in its own words and in its own order.
 *
 * The Ruby renderer also `scrub`s each string of invalid UTF-8 byte
 * sequences, because its source is bytes; a TypeScript string is always
 * validly encodable (invalid-UTF-8 file lines are kept as `null` text and
 * never parsed, and response bodies are decoded before they reach a string),
 * so the port collapses to the type filter alone.
 *
 * @param values the struct's reasons — an array, a lone problem string, or null
 */
function reasons(values: string[] | string | null): string[] {
  const list = values === null ? [] : Array.isArray(values) ? values : [values];
  return list.filter((value): value is string => typeof value === "string");
}
