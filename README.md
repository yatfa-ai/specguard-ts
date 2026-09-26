# @yatfa/specguard

> The TypeScript client for [SpecGuard](https://github.com/yatfa-ai/specguard): `node:test`, Vitest, and Jest
> reporters that ship test-run telemetry.

Published as **`@yatfa/specguard`**; the repository is still named `specguard-ts`, because the bare
`specguard` on npm belongs to an unrelated package. The scope is what drops the suffix from the installed
name — nothing else about the client changed with it, the `User-Agent` below included.

The shape deliberately mirrors [`specguard-rspec`](https://github.com/yatfa-ai/specguard-rspec), the Ruby
client: same environment variables, same wire contract — a team running both languages against one SpecGuard
deployment configures them identically, and the two clients are distinguishable on the platform only by
`User-Agent` (`specguard-ts/<version>`).

**This slice ships the node:test, Vitest, and Jest reporters, the `specguard lint` command, and the `specguard-ingest` replay
command.** The reporter carries `@intent:` annotations on the telemetry path: an annotation the
`validate-intent` binary ratified and that is attributed to a test ships as `status: "annotated"`
with the finding's intent object verbatim. A run with zero annotations remains valid by
construction and is still the platform's primary path.

---

## Status

Implemented and tested in this repository: a runner-agnostic core (envelope construction, per-example row
shape, stable id composition, transport with the never-fail guarantee), the `node:test` adapter, the
Vitest adapter, the Jest adapter, the `specguard lint` command, and the `specguard-ingest` replay bin with
the two-file sink split (the local development record and the replay queue), all built on that core.
Published to npm as `@yatfa/specguard`.

The wire format below is read from SpecGuard's own `Ingest::Payload` validator and is authoritative.

---

## Install

```bash
npm install --save-dev @yatfa/specguard
```

The package is ESM-first, ships its own type declarations, and targets Node 20+. It has no runtime
dependency on anything — `node:test` is part of Node itself, and Vitest and Jest are **optional peers**:
installing this package into a `node:test` project pulls in neither runner and warns about nothing.

## The reporter

A [`node:test` custom reporter](https://node.dev/api/test.html#custom-reporters). Point Node at it with a
second `--test-reporter` flag — the default reporter stays, and the two do not interfere:

```bash
node --test --test-reporter=spec \
  --test-reporter=./node_modules/@yatfa/specguard/dist/node-test/reporter.js
```

(If you run `node --test` with no directory argument it globs `**/*.test.js` for you; the reporter works
with either form, and with `--test-concurrency`.)

Set an API key and an endpoint and the run is POSTed to `<endpoint>/api/v1/ingest` — once per process, as a
single request:

```bash
export SPECGUARD_ENDPOINT=https://specguard.example.com
export SPECGUARD_API_KEY=sgk_…      # from your repository's settings
export SPECGUARD_TIMEOUT=10         # optional; seconds, applied to the whole delivery
```

**The API key is the switch.** With no key nothing is sent anywhere and the run is written to
`log/test_results.local.jsonl` — the **local development record** — so local development needs no opt-out
and a fork with no secret configured behaves like a laptop rather than like a broken build. Its name is
configurable via `SPECGUARD_LOCAL_OUTPUT_PATH`. The write itself is silent when it succeeds — the
ordinary case on any machine that can create `log/` — and a run whose local write failed says so instead
of staying quiet:

**When the local file cannot be written, the keyless run is not silently lost.** A read-only mount, a
full disk, a regular file sitting where the directory should be: the reporter prints **one** line to
stderr naming the **configured** path and the underlying error, whatever it is, and the test run is
unaffected. Nothing goes to the replay queue, and the outcome is still `"skipped"`. The path in the line
is the client's own — the one your configuration set — and it has to be, because a failure like a closed
stream carries no path of its own:

```
SpecGuard: could not write telemetry to log/test_results.local.jsonl
(closed stream). The test run is unaffected.
```

**A failed delivery is never silent.** If the endpoint refuses the run (a `401` from a
rotated key, a `400`, a `500`) or cannot be reached at all, the reporter prints **one** line to stderr
naming the status or the error, and appends the payload to `log/test_results.jsonl` — the **replay
queue** — so the run can be replayed later with
[`specguard-ingest`](#replaying-a-saved-run):

```
SpecGuard: could not deliver test telemetry (HTTP 401 — the API key was not
accepted). Falling back to log/test_results.jsonl; the test run is unaffected.
```

If the replay queue cannot be written either, the reporter does not pretend otherwise: no fallback is
promised and nothing is called "unaffected" — the status line stands alone, and a second line names
the queue path and states the loss. That is a run whose telemetry was lost; `deliver` reports it as
outcome `"lost"`:

```
SpecGuard: could not deliver test telemetry (HTTP 401 — the API key was not accepted).
SpecGuard: could not write telemetry to log/test_results.jsonl (EEXIST: file already exists, mkdir 'log'), so this run's telemetry was lost.
```

There are **no retries**, and the whole delivery is bounded by the timeout (10 seconds by default):
telemetry is explicitly allowed to be lost, and a retry would only double what a hung endpoint can cost
your CI run.

### The never-fail guarantee

Telemetry never fails a suite run — this is the single hardest constraint in the client and it outranks
every other goal here. Concretely:

- Every step is guarded; no reporter code path can throw out of the event stream.
- The process exit code is never touched. A failing suite exits 1 because the suite failed; a passing
  suite exits 0. The reporter adds nothing to either.
- A non-2xx response is checked for explicitly rather than left to a `catch` — Node's `fetch` resolves a
  `401` or a `500` as an ordinary `Response`, so a wrong API key throws nothing and would otherwise
  disappear in complete silence.

### What the reporter does to `node:test` events

Five things in the raw event stream would silently corrupt the payload, and the reporter handles each:

1. **`describe` blocks emit their own `test:pass` / `test:fail` events** — filtered out, so a suite of
   N tests in M describes produces exactly N rows, and a failing nested test is reported once, not twice
   through its parent suite.
2. **`duration_ms` is milliseconds; the wire field `duration` is seconds** — divided by 1000.
3. **`file` is an absolute path** — relativized against the repo root (the process working directory).
4. **The event stream carries no ancestry, only a leaf name and a nesting integer** — the composed
   `describe > describe > test` name is reconstructed from a start/result stack (suites close in strict
   LIFO order, which is pinned by a test because it is an observed behaviour, not a documented guarantee).
   Identity on the platform is semantic and derived from the text, so a bare leaf like `"works"` is not
   distinguishing.
5. **A skipped test emits `test:pass` with `skip: true`** — shipped with outcome `"pending"`, never
   silently counted as a pass.

One more, discovered while testing: **a test file that contains zero tests emits one synthetic `test:pass`
for the file itself** (its name is the absolute file path). It is filtered; a zero-test file ships nothing
and crashes nothing.

### How an annotation is attributed to a test

Before the POST, the annotation pass resolves each `@intent:` annotation to the test it belongs to. The
lookup is ordered — the first arm that matches claims the annotation:

1. **The test's own line first** — a trailing `// @intent: …` on the test's call line belongs to that test,
   whatever sits above it.
2. **Otherwise a comment-only `// @intent:` line directly above the call line** — the preceding-comment
   form. A trailing annotation on *another* test's line is never inherited by the row below it.

An annotation the `validate-intent` binary rejects, or one that cannot be attributed to any test, ships
`status: "unannotated"` and never fails the run. So does a test with no annotation at all — a run with
zero annotations is valid by construction. Both arms apply to every adapter below.

## The two sinks, and replaying a saved run — `specguard-ingest`

Two kinds of run end up on disk instead of on the platform, and they mean different things, so they go to
**two different files**:

| File | Written when | Default name | Override |
| --- | --- | --- | --- |
| local development record | no API key is configured (the key is the switch); a failed write prints one stderr line naming the configured path and the error | `log/test_results.local.jsonl` | `SPECGUARD_LOCAL_OUTPUT_PATH` |
| the **replay queue** | a delivery was attempted and not accepted | `log/test_results.jsonl` | `SPECGUARD_OUTPUT_PATH` |

The split is the fix, not decoration: **nothing on a written line records which sink it was destined for**,
so a file that ever mixes the two meanings can never be separated after the fact — no filter, no heuristic.
The writer keeps them apart precisely so this cannot happen.

> **A `log/test_results.jsonl` written by an earlier version of this package may already mix both
> meanings** (before slice 6, keyless runs and failed deliveries shared one file). The replay bin will
> send every line in such a file, and nothing can change that: guessing which lines "were failures" from
> data that does not say would be confidently wrong about which of your runs reach the platform. **Check
> the file before you replay one you did not write** — that is what [`--list`](#checking-a-file-before-you-send-it----list)
> is for. A queue file written entirely by this version or later holds only genuine failed deliveries by
> construction. If you deliberately want one file for both roles, point both variables at the same path.

### Replaying a saved run

The suite is over by the time you see the `401`, and re-running it to recover the telemetry costs you the
whole suite again. So the file the reporter wrote *is* the run: each line is byte-for-byte the body the
endpoint was offered, and `specguard-ingest` is the command that sends it:

```bash
export SPECGUARD_API_KEY=…            # the key that was rotated, fixed
specguard-ingest log/test_results.jsonl
```

`specguard-ingest --version` (also `-v`) prints the same one identity line and
exits 0 — it needs no file, no endpoint and no API key.

```
line 1: accepted — HTTP 202, test_run_id 41f2c9b8, ci_run_id 17442
line 2: accepted — HTTP 202, test_run_id 41f2c9b8, ci_run_id 17442
specguard-ingest: delivered 2 of 2 runs from log/test_results.jsonl
specguard-ingest: lines 1, 2 carried ci_run_id 17442 and each came back with
test_run_id 41f2c9b8 — the endpoint folded them onto one run
```

It reads the same `SPECGUARD_ENDPOINT`, `SPECGUARD_API_KEY` and `SPECGUARD_TIMEOUT` the reporters do, and
sends each line through the same delivery path — URL join, gzip threshold, headers, timeout — so a replay
reaches the endpoint exactly as the original delivery would have. Each line is delivered **once**, with no
retry: the command runs out of band, and re-running it is the retry made by someone who can see why the
first attempt failed.

Each line is reported by its **line number in the file you gave it**, and the folding observation is
stated only where it was *observed* — two lines that went out with one `ci_run_id` and came back with one
`test_run_id`. The tool does not claim to know whether a single line folded onto an existing run or
created a new one; the platform does not say.

### Checking a file before you send it — `--list`

`--list` prints one row per line — branch, commit_sha, `ci_run_id` or its absence, example count,
duration; every field already on the line, nothing guessed at — and **delivers nothing**:

```bash
specguard-ingest --list log/test_results.jsonl
```

```
line 1: branch main, commit_sha 0d4a1f2c9b8e7d6a5f4c3b2a1908f7e6d5c4b3a2, ci_run_id 17442, 412 examples, 93.4s
line 2: branch spike/local, commit_sha 9c2e7a10b4d3, no ci_run_id, 6 examples, 0.4s
line 3: unparseable — could not parse the line as JSON: unexpected end of input
specguard-ingest: listed 3 lines from log/test_results.jsonl; nothing was delivered
```

A line the command cannot parse is listed **as unparseable** rather than quietly dropped from the
preview. `no ci_run_id` is the one to read for: that line has no identity for SpecGuard to fold a
redelivery onto, so sending it creates a new run rather than joining an existing one.

**It needs no `SPECGUARD_ENDPOINT` and no `SPECGUARD_API_KEY`** — deliberately. The file most worth
checking is the one written *because* no API key was set, so requiring a key to look at it would withdraw
the instrument in exactly the situation that produces the hazard.

### Resuming and selecting lines

A file that was only partly accepted is resumed from the line the report named, rather than blindly
re-sent — the numbering never shifts between invocations that do not drain (`--drain` is the one
exception: removing the accepted lines renumbers what is left, so a drain report's numbers describe
the file as it was read, not as the next run finds it — see
[Draining the queue as it is accepted](#draining-the-queue-as-it-is-accepted----drain)):

```bash
specguard-ingest --from-line 7 log/test_results.jsonl     # a suffix: skip lines 1-6
specguard-ingest --lines 3,7,12-15 log/test_results.jsonl # an explicit set over the same numbering
specguard-ingest --from-line=7 log/test_results.jsonl     # the attached form, identical in every way
```

- **Both forms are accepted for both flags** — `--from-line 7` and `--from-line=7`, `--lines 3,7` and
  `--lines=3,7` — and they are the same flag, not two: the attached form routes into the same validator,
  so every message, exit code and repeat/exclusion rule below applies to it unchanged. A near-miss like
  `--from-linex=3` is still an `invalid option` (exit `2`); only the exact name plus `=` is the flag.
- `--from-line N` is a suffix (N ≥ 1); `--lines` takes numbers and ranges — kept as ranges, never
  expanded — over the file's own numbering. Both compose with `--list`, which then previews exactly the
  set a delivery would send.
- **The two flags do not combine** (exit `2`): they answer the same question, and intersecting them would
  silently drop a number you typed — `--from-line 5 --lines 3,7` would send only line 7 and the 3 would
  vanish without a word.
- **Repeating one flag is allowed and last-wins**: `--lines 1,2 --lines 4` sends line 4. A repeat
  replaces rather than intersects, and it is what lets you override a selector baked into a wrapper
  script.
- Every malformed spec is a `2` naming what was wrong — `--lines 0`, `--lines 5-2`, `--lines abc`,
  `--lines 12-`, an empty spec, an empty entry (`3,,5`) — never a fallback to the whole file, which is
  the one outcome a selector exists to prevent. Whitespace *between* entries is fine (`3, 7`); inside
  one it is a typo (`5 - 7` is refused).
- A selector naming lines past the end of the file is **not** an error: nothing is selected, exit `0`,
  and the warning names what was held back — under `--lines` also the numbers the file does not have
  (below).
- Held-back lines are **counted and reported** in the summary, with accurate singular/plural wording
  ("2 earlier lines skipped by --from-line", "1 line not selected by --lines", "1 blank line skipped") —
  a summary that quietly narrowed what it was summarising would be worse than no summary.
- A `--lines` number the file **does not have** is the same rule pointed the other way, and it gets
  its own clause rather than being left to the held-back count — `--lines named 33-40, which the file
  does not have`. A range that is only **half** answered says so on the same terms: the clause names
  the portion past the end of the file, in the shorthand you typed, because what you act on is the
  numbers you wrote. A line the file *does* have and that is blank is a blank line and is reported as
  one; only numbers past the end of the file reach this clause, so no line is ever named under two
  causes. The clause is additive: a file that is at once short, blank-bearing and selected-away states
  each cause and drops none of it. The same fact rides `--json` as `summary.absent` — `null` when the
  selector was fully satisfied, never `[]`.
- Nothing about a line's **content** is consulted by either flag. The numbers come from you, after
  reading `--list`; that is what keeps this an explicit selector rather than the heuristic this command
  refuses to grow.

### Draining the queue as it is accepted — `--drain`

The replay queue is *runs offered to the endpoint and not accepted* — and until the run is drained, a
line the endpoint **did** accept stays in it. The next incident's failures append behind it, and
"re-running the command is the retry" then re-sends every one of those already-accepted runs: harmless
when the line carries a `ci_run_id` (it folds onto the run it already made), a duplicate row when it
does not. `--drain` is the opt-in follow-through:

```bash
specguard-ingest --drain log/test_results.jsonl
```

```
line 1: accepted — HTTP 202, test_run_id 41f2c9b8, ci_run_id 17442
line 2: not delivered — HTTP 503 — upstream is down
specguard-ingest: delivered 1 of 2 runs from log/test_results.jsonl; 1 could not be delivered; 1 accepted line removed from log/test_results.jsonl
```

Only the lines answered `202` **in this invocation** are removed — there is no heuristic and nothing is
guessed at, which is the same line the rest of this command draws. Everything else stays
**byte for byte, in the file's order**:

- **refused** lines — a `400` is refused every time it is offered, and the payload still needs fixing;
- **undelivered** lines — the endpoint never stored them, so they were never accepted;
- **unparseable** lines — never a run, so never accepted;
- **blank** lines — never anything;
- every line **`--from-line` or `--lines` held back** — it was not sent, so it was not accepted,
  whatever the endpoint would have said.

The rewrite is **atomic**: a temporary file in the same directory, renamed over the original, so a
failure mid-drain leaves the file exactly as it was — and nothing is written at all unless something
was actually accepted. The swap also keeps the queue file's permissions, and when the queue path is a
symlink it rewrites the link's target rather than replacing the link.

**The removal renumbers what it leaves.** The rewrite keeps the surviving lines byte for byte and in
order, and packing them up from the top gives them new numbers: a queue of
`[accepted, not delivered, accepted]` becomes a two-line file whose former lines 2 and 3 are now lines
1 and 2 — while the report above still says `line 2`, because that number describes the file **as it
was read**. That is deliberate: the report is a receipt about the file this invocation opened, and
emitting post-drain numbers would make it disagree with the file it read. So do **not** feed a drain
report's numbers to the next command's `--from-line` or `--lines` — when lines remain, the summary's
drain clause says so in as many words. The resume is simply: re-run `--list` to see the renumbered
file, or run `--drain` again. The "the numbering never shifts" guarantee holds between invocations
that do not drain.

**A concurrent append is carried.** The reporter appends to the queue with no lock, so a run can land
while the deliveries are still going. Bytes appended after the file was read and before the rewrite
are carried into it verbatim. One window remains — the instant between the final read and the rename —
and it is disclosed in the code rather than claimed closed; closing it would take a lock in the
reporter, which is deliberately not this flag's business.

**Only the replay queue is drained.** Another path is refused with a `2` — the local record
`log/test_results.local.jsonl` is a development record, not a queue, and removing accepted lines from
it would delete ordinary laptop runs that were never failures. The comparison is exact: the file must
be spelled as `SPECGUARD_OUTPUT_PATH` (or the default) configures the queue. `--drain` with `--list`
is refused with a `2` as well — a listing delivers nothing, so there is nothing for it to drain.

The removal is **stated, never silent**: the summary gains the clause above, and the `--json`
document's `summary` carries a `drained` count (absent without the flag). When lines remain after the
rewrite, the clause carries its second half and says so: the surviving lines are renumbered, and the
report's numbers above — which describe the file as it was read — no longer address it. A drain that
cannot complete is a `2` — the delivery report still prints in full, a warning on stderr names the
file, and the file is left as it was, because a `0` would read as "drained" about a queue that was
not.

When the whole queue was accepted, the file is left **empty**, and the next `specguard-ingest` run —
with or without `--drain` — sends nothing, warns, and exits `0`, exactly as it does over any empty
file. Draining by default is deliberately not the behaviour: a tool that deletes your queue unless
told not to has made the product decision for you.

### Machine-readable output — `--json`


An HTTP `400` is the one **permanent** verdict in the exit-code table below: a refused line is refused
every time it is offered, so the only way to land the run is to learn which specs SpecGuard objected to
and fix the payload. It names **every** one of them — one error per offending spec — and the human line
has room for only a fragment of that: the refusal body flattened to one line and hard-truncated at 300
characters, not even valid JSON to paste anywhere.

That cap is right where it is: it exists for the **one line** a report row is allowed, and `specguard-ingest`
already prints a row per line, out of band, nowhere near a CI log. `--json` is the other channel — stdout
carries one JSON document instead of the human report, with the whole list in it:

```bash
specguard-ingest --json log/test_results.jsonl
```
```json
{
  "tool": "specguard-ingest",
  "mode": "deliver",
  "file": "log/test_results.jsonl",
  "summary": {
    "lines": 3,
    "attempted": 3,
    "accepted": 2,
    "refused": 1,
    "undelivered": 0,
    "unparseable": 0,
    "blank": 0,
    "skipped": 0,
    "absent": null,
    "selector": null
  },
  "lines": [
    { "number": 1, "status": "accepted", "code": 202, "reasons": [],
      "test_run_id": "41f2c9b8", "ci_run_id": "17442" },
    { "number": 2, "status": "accepted", "code": 202, "reasons": [],
      "test_run_id": "41f2c9b8", "ci_run_id": "17442" },
    { "number": 3, "status": "refused", "code": 400, "test_run_id": null,
      "ci_run_id": "17443",
      "reasons": [
        "specs[417] spec/models/user_spec.rb:88: duration must be a non-negative number when present",
        "specs[418] spec/models/user_spec.rb:96: duration must be a non-negative number when present"
      ] }
  ],
  "foldings": [
    { "ci_run_id": "17442", "test_run_id": "41f2c9b8", "lines": [1, 2] }
  ]
}
```

| field | meaning |
| --- | --- |
| `tool` | always `"specguard-ingest"`. Deliberately **not** a schema id: this document is about deliveries, and `specguard lint --json` is the one that carries the lint document |
| `mode` | `"deliver"` or `"list"` — whether the lines were sent or only shown |
| `file` | the path you gave it, echoed back |
| `summary.lines` | rows in `lines`: the lines that carried a payload and were not held back by a selector |
| `summary.attempted` | how many of those were offered to the endpoint — always `0` under `--list` |
| `summary.accepted` / `refused` / `undelivered` / `unparseable` | the same four counts the text summary line states, computed once for both renderers so they cannot disagree |
| `summary.blank` / `skipped` | the two ways a line of the file is not a row here, counted rather than dropped |
| `summary.absent` | the `--lines` numbers the file does not have, in the shorthand you typed them — a number or an `N-M` range per entry — or `null` when the selector was fully satisfied; never `[]`, on `selector`'s terms |
| `summary.selector` | `"--lines"`, `"--from-line"`, or `null` when nothing was held back |
| `summary.drained` | with `--drain`: how many accepted lines were removed from the file — `0` where the flag asked and nothing was accepted. Absent without the flag, and never present under `--list`, which cannot drain. When `drained` is greater than `0`, each `lines[].number` refers to the file **before** the drain: the rewrite renumbers the lines it leaves, so those numbers describe the file as it was read and no longer address the rewritten file |
| `lines[]` | one entry per row, in the file's order |
| `foldings[]` | folding, **observed**: the lines that went out with one `ci_run_id` and came back with one `test_run_id`. The same statement the text report makes as a sentence |

Every delivered line has the same six keys — `number`, `status`, `code`, `reasons`, `test_run_id`,
`ci_run_id`. `status` uses the tool's vocabulary (`undelivered`, where the text row prints `not
delivered`). `code` is the HTTP status, or **`null`** where there is not one: a line that was never a
run, and a delivery that got no answer at all. `reasons` is why the line did not land — **always** a list
of strings, never null and never a bare string, so a consumer never branches on its type: SpecGuard's own
per-spec errors on a refusal (**all** of them, in its order, uncapped), the parse problem where the line
was not a run, the error where nothing reached the endpoint, and `[]` where it landed or where the
refusal's body said anything unreadable. `test_run_id` and `ci_run_id` are `null` where the row says
`(not reported)` / `no ci_run_id`.

A `--list` document has the same shape with `"mode": "list"`: every delivery count is `0`, `attempted` is
`0`, `foldings` is `[]`, and each line has the eight keys `number`, `status` (`"listed"` or
`"unparseable"`), `reasons`, `branch`, `commit_sha`, `ci_run_id`, `examples`, `duration_seconds` — the
envelope facts the text row prints, as values, with **`null`** where the row says `no branch` / `no
specs` / `no duration_seconds`. `--list --json` needs no `SPECGUARD_ENDPOINT` and no `SPECGUARD_API_KEY`,
exactly as `--list` does.

Four things worth knowing:

- **The exit code is identical with and without the flag**, and the default output is unchanged:
  `--json` is a second renderer over the same lines, the same statuses and the same counts.
- **`--json` does not lift the cap on the human line.** The two channels render the same refusal at
  different lengths on purpose; nothing about the report's wording moves.
- **A run that never got as far as reading the file emits no document.** A bad flag, `--from-line` with
  `--lines`, no endpoint or API key, a file that cannot be read — all still exit `2` with prose on stderr
  and **nothing** on stdout, because there is nothing yet to be a document about. A file the command *did*
  read always gets one, whatever the exit code, including an empty one.
- **Warnings stay on stderr**, in both renderers. A run that delivered nothing is still loud there;
  stdout is the document and nothing else.

### The exit codes are the contract

| Code | Meaning |
| --- | --- |
| `0` | every line was accepted — including the vacuous empty file (a loud stderr warning, not a code) |
| `1` | at least one line was **refused by the endpoint** — it read the payload and said no (HTTP `400`, the one response the platform forms an opinion about a payload in) |
| `2` | this tool could not do its job — bad flags, no endpoint or API key, an unreadable file, an unparseable line, a delivery that never reached the endpoint, or one the endpoint answered without ever reading it (`401`, `404`, `429`, `5xx`: nothing was stored, so none of them is a verdict about your run) |

`2` dominates `1`: a file where line 3 was refused and line 7 never arrived exits `2`, because the second
fact is the one that leaves work undone — both are printed either way; the exit code chooses what to
shout, never what to say. With `--list` the only reachable codes are `0` (listed) and `2` (bad flag,
unreadable file): listing delivers nothing, so it can never carry a verdict about a run. With
`--drain`, a rewrite that could not complete is a `2` as well — the file is left as it was. The command
**never throws** — a load failure or an internal error is a `2` with one stderr line, not a stack trace.

## The Vitest reporter

The same telemetry for [Vitest](https://vitest.dev) ≥ 4.0.0, as a [custom
reporter](https://vitest.dev/advanced/api/reporters) that reuses the runner-agnostic core unchanged — the
second adapter the core was built to admit. Configure it beside the default reporter:

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["default", "@yatfa/specguard/vitest"],
    includeTaskLocation: true, // without this, Vitest reports no line numbers
  },
});
```

Environment variables, the wire contract, sharding, and the never-fail guarantee are exactly the
`node:test` reporter's — one team running both runners configures them identically, and rows from the two
runners land in the same envelope shape with the same stable-id composition.

**`includeTaskLocation: true` is required.** The wire contract needs each row's `line_number`, and Vitest
populates test locations only when this option is set — a measured fact pinned by test, not a documented
one assumed. Without it every row is dropped with **one** stderr line naming the setting, nothing POSTs,
and the run's own results and exit code are untouched. (The dropped rows are counted, not silently lost.)

**Vitest ≥ 4, specifically.** Vitest 4 replaced the reporter API this adapter reads (`onTestRunEnd`; on
Vitest ≤ 3 that hook does not exist and the old `onFinished` hook fires instead). On an older Vitest the
reporter is a visible no-op — one stderr line saying telemetry was not sent — rather than a silent one.
Supporting the pre-4 hook is deliberately not attempted: everything this package claims is measured
against a real runner, and only Vitest 4 is installed in this repository's test path.

### What the reporter does to Vitest events

The mapping decisions, each measured against a real `vitest run` (and pinned by
`test/integration.vitest.test.ts`):

1. **`location.line` points at the 1-based `test(` call line** — the same anchor `node:test` reports, so an
   annotation in the preceding-comment form sits exactly one line above `location.line`. The offset was
   re-measured on Vitest's coordinates rather than inherited, and is pinned by a fixture test. How an
   annotation is attributed to a test is stated once in
   [the reporter section](#how-an-annotation-is-attributed-to-a-test).
2. **`diagnostic().duration` is milliseconds; the wire field `duration` is seconds** — divided by 1000.
   Skipped tests carry no diagnostic at all and ship `duration: null`.
3. **`moduleId` is an absolute path** — relativized against the repo root (the process working directory),
   exactly as the `node:test` reporter relativizes `file`.
4. **`fullName` is the composed name** — `"outer suite > inner suite > test"`, module path excluded, the
   same composition the `node:test` reporter reconstructs from its event stack. Vitest hands it over
   directly; the wire contract gets the same string either way.
5. **Both `test.skip` and `test.todo` surface as state `"skipped"`** — shipped with outcome `"pending"`,
   never silently counted as a pass.
6. **Suites produce no rows** — only tests do; a failing child is reported once, not again through its
   parent.
7. **A never-finished test (state `"pending"`, an interrupted run) is not a result** — its row is dropped
   and counted rather than shipped with a guessed outcome.

**In watch mode every rerun is a run**: each rerun ships one POST with its own duration, measured from the
rerun boundary. **A failing suite stays failing**: Vitest awaits the reporter's run-end hook, and a hook
that throws would surface as a Vitest *Unhandled Error* that can fail an otherwise passing run — which is
why every step in this reporter is guarded, and why that fact is pinned by test.


## The Jest reporter

The same telemetry for [Jest](https://jestjs.io) ≥ 30.0.0, as a [custom
reporter](https://jestjs.io/docs/configuration#reporters-array) that reuses the runner-agnostic core
unchanged — the third adapter the core was built to admit. Configure it beside the default reporter:

```js
// jest.config.mjs
export default {
  reporters: ["default", "@yatfa/specguard/jest"],
  testLocationInResults: true, // without this, Jest reports no line numbers
};
```

Environment variables, the wire contract, sharding, and the never-fail guarantee are exactly the
`node:test` and Vitest reporters' — one team running all three runners configures them identically, and
rows from every runner land in the same envelope shape with the same stable-id composition.

**`testLocationInResults: true` is required.** The wire contract needs each row's `line_number`, and Jest
populates each test's `location` only when this option is set — a measured fact pinned by test, not a
documented one assumed. Without it every row is dropped with **one** stderr line naming the setting,
nothing POSTs, and the run's own results and exit code are untouched. (The dropped rows are counted, not
silently lost.)

**Jest ≥ 30, specifically.** The facts this adapter rests on were measured against a real Jest 30 child
process, and the reporter's constructor reads Jest 30's three-argument shape
(`(globalConfig, options, docs)` — the adapter's options are the *second* argument; Vitest hands one
options object, and neither shape was assumed). Older Jests are untested, and the peer range says so.

### What the reporter does to Jest events

The mapping decisions, each measured against a real `jest` run (and pinned by
`test/integration.jest.test.ts`):

1. **`location.line` points at the 1-based `it(` call line** — the same anchor `node:test` and Vitest
   report, so an annotation in the preceding-comment form sits exactly one line above `location.line`
   here too. The offset was re-measured on Jest's coordinates rather than inherited, and is pinned by a
   fixture test. How an annotation is attributed to a test is stated once in
   [the reporter section](#how-an-annotation-is-attributed-to-a-test).
2. **`fullName` is never read.** Jest composes it by joining ancestry with a *single space*
   (`"outer suite inner suite test"`), a separator no other adapter produces — so the composed name is
   recomposed from `ancestorTitles` + `title` with the `" > "` join the other two adapters emit, and
   cross-runner row names stay one contract.
3. **Per-test `duration` is milliseconds and exists on Jest 30** (Jest's ancestors reported durations
   only at suite level); the wire field `duration` is seconds — divided by 1000. Skip-family tests carry
   `duration: null`, and the client never fabricates one.
4. **`it.skip` surfaces as status `"pending"` and `it.todo` as `"todo"`** — the whole skip family
   (`pending`, `todo`, `skipped`, `disabled`) ships with outcome `"pending"`, never silently counted as a
   pass. `it.concurrent` surfaces as an ordinary result.
5. **The suite's `testFilePath` is an absolute path** — relativized against the repo root (the process
   working directory), exactly as the other two reporters relativize their file fields.
6. **Suites produce no rows** — only tests do; a failing child is reported once, not again through its
   parent.
7. **An unrecognized status is not a result** — its row is dropped and counted rather than shipped with a
   guessed outcome.

**In watch mode every rerun is a run**: `onRunStart` re-arms the run clock, and each rerun ships one POST
with its own duration. **A failing suite stays failing — and a passing one must stay passing**: Jest
awaits an async `onRunComplete`, and a hook that throws surfaces as the CLI error and fails an otherwise
passing run (measured: exit 1), which is why every step in this reporter is guarded, and why that fact is
pinned by test. Jest's own default reporter writes everything to **stderr** (measured: stdout is empty),
so this adapter's footprint — the `SpecGuard:` lines — sits beside Jest's output on the same stream, and
a run with the reporter is byte-identical to one without it modulo timings and those lines.


## Stable per-example ids

`id` is the upsert key: SpecGuard writes one observation row per `(test_run_id, example_id)` and a repeated
id inside one delivery is collapsed to its first occurrence. It is the field that lets a re-run **replace**
an example's numbers rather than duplicate them, and the one per-example field the endpoint does not
validate — a client that sends an unstable id corrupts its own history and gets no error saying so.

This client composes it as a SHA-1 over the project-relative `file_path` and the composed full name:
stable across runs for an unchanged test, stable across shards, independent of execution order. Never an
index into the run.

## If you shard your suite

Each process loads the reporter and POSTs its own slice; `ci_run_id` is what tells SpecGuard those POSTs
are **one run**, so a 20,000-test suite reports a 20,000 denominator instead of four records holding a
quarter each. Every supported provider publishes a build id, so a sharded job needs no configuration:

| Field | Resolved from |
| --- | --- |
| `ci_run_id` | `SPECGUARD_RUN_ID`, else `GITHUB_RUN_ID`, `CI_PIPELINE_ID`, `CIRCLE_WORKFLOW_ID`, `BUILDKITE_BUILD_ID`, `BUILD_TAG` |
| `shard_id` | `SPECGUARD_SHARD_ID`, else `CI_NODE_INDEX`, `CIRCLE_NODE_INDEX`, `BUILDKITE_PARALLEL_JOB` |

`ci_run_id` and `shard_id` are refused by the endpoint as JSON **numbers** rather than coerced, and this
matters more in TypeScript than it did in Ruby: a shard index composed in code is a `number` and
`JSON.stringify` will happily emit `0`. `0` and `"0"` key different shards of one run, which would let a
shard fail to replace itself. **Both are stringified at the edge**, in the environment reader and again in
the envelope builder.

## The `validate-intent` binary

Later slices of this client (annotation lint, intent-on-telemetry) shell out to a `validate-intent`
binary from [open-test-intent](https://github.com/yatfa-ai/open-test-intent). That resolution layer
already exists and never throws; importing this package stays safe on any platform, with or without a
binary, and the telemetry reporter is unaffected by every unavailable state.

A binary is resolved in a fixed precedence, mirroring the Ruby client's documented precedence:

1. **`SPECGUARD_VALIDATE_INTENT`** names a binary — an absolute or relative **path**, never a bare
   command name (which binary validated a CI job should not depend on what else happens to be on
   `PATH`). **Blank counts as unset**: `SPECGUARD_VALIDATE_INTENT=` in a CI environment file is
   somebody asking for the default resolution, not for a binary named `""`.
2. **An npm-distributed prebuilt**, an optional dependency matched to your platform by `os`/`cpu`.
   Nothing is published yet, so today this step resolves nothing and the answer is (3).
3. **`unavailable`** — a typed state with a machine-readable code (`no-binary`, `override-missing`,
   `override-not-executable`, `override-not-a-path`, `not-executable`,
   `schema-contract-mismatch`), never a throw. A platform with no prebuilt binary degrades; it does
   not break.

On every successful resolution the binary's identity is checked before it is used: it is probed with
`--version` and `--schema-source`, and the digest of the schema its runs would actually **enforce**
(a `schemas/open-test-intent.v1.json` beside the executable takes precedence over the compiled-in
copy) is compared against the schema contract this client targets. A binary enforcing a different
schema is refused with a reason distinct from "missing" — a wrong-contract binary is worse than no
binary. A binary predating `--schema-source` falls back to the digest carried in its `--version`
line.

A shard must be able to **replace** its own earlier numbers rather than add to them, which means naming
itself — press "re-run failed jobs" and only the failed shards run again, inside the same `ci_run_id`.
Leaving `shard_id` unset is not an error and does not lose the slice; what it cannot do is be recognised on
a second delivery. (For the same reason `GITHUB_RUN_ID` — not `GITHUB_RUN_ATTEMPT` — keys the run: a
"re-run all jobs" delivers inside the same run id, so shards replace their numbers instead of doubling
the denominator.)

**GitHub Actions `matrix:` needs a line of config** — it exports no per-leg index:

```yaml
strategy:
  matrix:
    shard: [1, 2, 3, 4]
steps:
  - run: node --test --test-reporter=./node_modules/@yatfa/specguard/dist/node-test/reporter.js
    env:
      SPECGUARD_SHARD_ID: ${{ matrix.shard }}
```

## The wire contract

`POST <endpoint>/api/v1/ingest`, `Authorization: Bearer sgk_…`, `Content-Type: application/json`. A body
over **256 KiB** is gzipped with `Content-Encoding: gzip` — that threshold is the Ruby client's, and
matching it keeps the two clients' behaviour on a large suite the same. Success is **`202 Accepted`**:

```json
{ "test_run_id": "41f2c9b8", "total_specs": 812, "annotated_specs": 190,
  "annotated_ratio": 0.234, "embedding_status": "queued" }
```

The counts are **derived server-side** from `specs[]` and are never read from the client — do not send
them.

**The envelope**, once per process:

| Field | Type | Rule |
| --- | --- | --- |
| `commit_sha` | string | **required**, non-empty. `SPECGUARD_COMMIT_SHA`, `GITHUB_SHA`, `CI_COMMIT_SHA`, `CIRCLE_SHA1`, `BUILDKITE_COMMIT`, `GIT_COMMIT`, else `git rev-parse HEAD` |
| `branch` | string \| null | `SPECGUARD_BRANCH` if you set it, else `GITHUB_REF_NAME`, `CI_COMMIT_REF_NAME`, `CI_COMMIT_BRANCH`, `CIRCLE_BRANCH`, `BUILDKITE_BRANCH`, `GIT_BRANCH`, else `git branch --show-current` — null on a detached checkout |
| `ci_run_id` | string \| null | **string, never a number** |
| `shard_id` | string \| null | **string, never a number** |
| `duration_seconds` | number \| null | non-negative |
| `specs` | array | **required** |

**Each spec** — one object per test that finished:

| Field | Type | Rule |
| --- | --- | --- |
| `file_path` | string | **required**, non-empty; project-relative |
| `line_number` | integer | **required**, positive — taken from the event's `line`, always present on `node:test` result events |
| `status` | `"annotated"` \| `"unannotated"` | `"annotated"` when a ratified `@intent:` is attributed to the test, otherwise `"unannotated"` |
| `intent` | object \| null | **must be null** when unannotated |
| `name` | string | non-empty; the composed describe/context/it name |
| `duration` | number \| null | non-negative, **seconds** |
| `id` | string | the upsert key — unvalidated, stability is on the client |
| `outcome` | string | free text; this client sends `passed`, `failed`, `pending` — the same three words the Ruby client sends |

A run with **zero** annotations is valid — missing annotations are never an ingestion failure, only
malformed ones are. What every spec owes is *something that represents it*: an intent or a `name`.

Every failure is collected rather than raised on the first one, and every per-spec message names the spec
it came from, so a `400` lists the whole problem at once.

## What SpecGuard collects

The tables above **are** the request body — there is no filtering layer between what the reporter captures
and what leaves the machine. Two request headers say something about you rather than about the request:
the API key travels as a bearer token in `Authorization`, and `User-Agent` names this package and its
version (`specguard-ts/<version>`), so the platform can tell its clients apart.

Test names and file paths are written by your developers, in prose, and **will** carry internal product
detail — because a suite describes the system it tests. SpecGuard is built on that and cannot be built
without it. There is no opt-out and no field-level redaction.

### If this cannot leave your perimeter, run SpecGuard inside it

Self-hosting needs no code change — point `SPECGUARD_ENDPOINT` at your own deployment.

### What is never collected

- **No source code.** Not your application's, and not your tests' — no test body, no fixture, no diff.
- **No failure messages and no stack traces.** A failing test contributes the string `failed` and nothing else.
- **No console output.** Nothing your suite printed, and nothing any other reporter wrote, is read or forwarded.
- **No environment.** A fixed list of variables is read and no others: the ones that fill `commit_sha`,
  `branch`, `ci_run_id` and `shard_id`, plus five that configure the client itself — `SPECGUARD_ENDPOINT`,
  `SPECGUARD_OUTPUT_PATH`, `SPECGUARD_LOCAL_OUTPUT_PATH`, `SPECGUARD_TIMEOUT`, and `SPECGUARD_API_KEY`,
  which leaves the machine only as the bearer token above.
- **Proxy settings are read, and this is the one exception** — they decide only *where* the run goes,
  never what is in it.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # builds dist/ from src, compiles src+test to .test-build/, runs node --test
npm run build       # compiles dist/
```

House conventions follow [`specguard-mcp`](https://github.com/yatfa-ai/specguard-mcp): ESM, `NodeNext`,
`strict` with `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` / `verbatimModuleSyntax` /
`erasableSyntaxOnly` on, `node --test`, Node >= 20. Fixtures under `fixtures/` are run by real child
`node --test` processes from the integration tests — their line numbers are load-bearing, and the tests
name them.

The Vitest end-to-end tests (`test/integration.vitest.test.ts`) run real `vitest run` child processes over
`fixtures/vitest/`, and because Vitest is an optional peer that this repository does not depend on, they
**self-skip when no Vitest is resolvable** — `npm install && npm test` is green on a machine with no
Vitest. To exercise them locally: `npm install --no-save vitest` and run `npm test` again. (CI runs these
self-skipped: its workflow has no Vitest-install step, so the tests above self-skip there until an
`npm install --no-save vitest` step is added to `.github/workflows/ci.yml` — pending a push with workflows
permission; see the slice 5 PR.)

The Jest end-to-end tests (`test/integration.jest.test.ts`) run real `jest` child processes over
`fixtures/jest/`, and because Jest is an optional peer that this repository does not depend on, they
**self-skip when no Jest is resolvable** — `npm install && npm test` stays green on a machine with no
Jest. To exercise them locally: `npm install --no-save jest` and run `npm test` again. (CI runs these
self-skipped for the same reason as Vitest's: the workflow has no Jest-install step.)

---

## `specguard lint`

Finds `@intent:` annotations in your `.ts/.tsx/.js/.jsx/.mjs/.cjs` sources and validates them
through the same Go `validate-intent` binary every other stack shares. The client never parses an
annotation payload itself — Node's `JSON.parse` accepts inputs the OpenTestIntent protocol rejects,
so extraction and validation both belong to the binary, invoked as `validate-intent --source --json
<files>`.

```bash
specguard lint            # walk the current directory
specguard lint src/a.ts   # check named files
specguard lint --changed  # check only what changed against the default branch
specguard lint --json     # machine-readable report on stdout
```

`specguard --version` (also `-v`, and the same flag after `lint`) prints one
line — `specguard-ts <version>`, the same version the HTTP client stamps into
its User-Agent — and exits 0 without discovering or scanning anything.

`--changed[=<base>]` is the CI selection mode: it picks the annotated sources
in the git diff against the **merge base with the default branch**
(`origin/HEAD`, then `origin/main`/`origin/master`, then their local names) —
never a bare working-tree-vs-index `git diff --name-only`, which is empty on a
clean CI checkout and would exit green having checked nothing. Deleted paths
are never selected; the selection is scoped to the current directory, matching
the walk (`--changed` under `<repo>/packages/app` checks that package's
changed files); `--changed=<base>` overrides the base for pipelines that know
better. Selection also takes in **untracked** files: a brand-new file that has
not been `git add`ed is part of what changed against the base, whether or not
the change is committed yet. One `git ls-files --others --exclude-standard`
call per run is unioned with the diff — `--exclude-standard` keeps
`.gitignore`d paths (scratch directories, vendored code, build output) out of
that untracked leg, but a tracked file is never subject to `.gitignore`, so
the diff leg has no fence of its own. `--changed` therefore applies the same
fixed directory list the walk skips (`node_modules`, `.git`, `dist`,
`.test-build`, `coverage`) to every path git hands back, on either leg —
a directory merely *named after* a fenced word (`src/dist_helpers/`) is
project code, and so is a file merely named `coverage.ts` — and when the
fence removed files, the `checked N source files changed since <base>` line
says `skipping M in dependency or build directories`. Untracked files obey
the same scoping as diffed ones, so an untracked file
outside the current directory is counted as outside, not checked. When the
untracked leg contributed, the `checked N source files changed since <base>`
line says `including M untracked`. Outside a git repository, or with no
resolvable base, the run is exit
2; when no default-branch ref exists the diff falls back to HEAD (uncommitted
work only) and says so on stderr. In a **shallow** checkout — the default
depth-1 `git clone` behind `actions/checkout@v4` — the merge base with the
default branch is not in the clone's history, so the derived base is HEAD
itself: the empty selection stays exit 0, and its stderr note (and `--json`
`selection.note`) names the checkout as **shallow** and the remedy — fetch the
default branch (`fetch-depth: 0`) or pass `--changed=<base>` naming a base the
checkout contains. An explicit `--changed=<base>` that is not in a shallow
checkout's history is exit 2 with that cause and the same remedy, not the bare
"could not diff against" a full clone reports for a genuinely bad ref. A
selection that comes up empty stays exit
0 and says WHY on stderr — nothing changed against the base (no tracked
change and no untracked annotated file), nothing matched
the annotated extensions, or everything that matched is outside the current
directory — so "checked nothing" can never read as "checked N files, found
nothing". `--changed` cannot be combined with named files (exit 2). A
`--changed` run discloses its provenance: `changed since <base>` in the human
report and a `selection` block (`mode`, `base`, `note`) in `--json`.

Point the client at a binary with `SPECGUARD_VALIDATE_INTENT=/path/to/validate-intent` (a path, not
a command name; see slice 2). Without a resolvable binary the command still works for repositories
that have nothing to check:

| Exit | Meaning |
|---|---|
| 0 | every annotation checked was valid — including "there were none" (a repo with zero annotations and no binary is still 0) |
| 1 | at least one annotation is malformed, or well-formed but unreachable — stacked above another comment-form `@intent:` line, so the one-line lookback only ever claims the line directly above the test and the rest of the stack is dead metadata |
| 2 | the linter could not do its job — misuse, a broken override, an unresolvable binary when annotations exist, unreadable files, or a backend failure |

An exit-2 run writes its reason to stderr and emits **no report document** — "could not check" is
never dressed as an empty clean-looking report. `--json` replaces the stdout report only; the exit
code and stderr are identical on both paths.
