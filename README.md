# specguard-ts

> The TypeScript client for [SpecGuard](https://github.com/yatfa-ai/specguard): `node:test`, Vitest, and Jest
> reporters that ship test-run telemetry.

The shape deliberately mirrors [`specguard-rspec`](https://github.com/yatfa-ai/specguard-rspec), the Ruby
client: same environment variables, same wire contract — a team running both languages against one SpecGuard
deployment configures them identically, and the two clients are distinguishable on the platform only by
`User-Agent` (`specguard-ts/<version>`).

**This slice ships the node:test, Vitest, and Jest reporters, the `specguard lint` command, and the `specguard-ingest` replay
command.** The reporter reads **no
`@intent:` annotations on the telemetry path**: every run it ships may be a zero-annotation
run, which is valid by construction and is the platform's primary path.

---

## Status

Implemented and tested in this repository: a runner-agnostic core (envelope construction, per-example row
shape, stable id composition, transport with the never-fail guarantee), the `node:test` adapter, the
Vitest adapter, the Jest adapter, the `specguard lint` command, and the `specguard-ingest` replay bin with
the two-file sink split (the local development record and the replay queue), all built on that core. Not
yet implemented: npm publishing.

The wire format below is read from SpecGuard's own `Ingest::Payload` validator and is authoritative.

---

## Install

```bash
npm install --save-dev specguard-ts
```

The package is ESM-first, ships its own type declarations, and targets Node 20+. It has no runtime
dependency on anything — `node:test` is part of Node itself, and Vitest and Jest are **optional peers**:
installing this package into a `node:test` project pulls in neither runner and warns about nothing.

## The reporter

A [`node:test` custom reporter](https://node.dev/api/test.html#custom-reporters). Point Node at it with a
second `--test-reporter` flag — the default reporter stays, and the two do not interfere:

```bash
node --test --test-reporter=spec \
  --test-reporter=./node_modules/specguard-ts/dist/node-test/reporter.js
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
configurable via `SPECGUARD_LOCAL_OUTPUT_PATH`.

**A failed delivery is never silent, and never lost.** If the endpoint refuses the run (a `401` from a
rotated key, a `400`, a `500`) or cannot be reached at all, the reporter prints **one** line to stderr
naming the status or the error, and appends the payload to `log/test_results.jsonl` — the **replay
queue** — so the run can be replayed later with
[`specguard-ingest`](#replaying-a-saved-run):

```
SpecGuard: could not deliver test telemetry (HTTP 401 — the API key was not
accepted). Falling back to log/test_results.jsonl; the test run is unaffected.
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

## The two sinks, and replaying a saved run — `specguard-ingest`

Two kinds of run end up on disk instead of on the platform, and they mean different things, so they go to
**two different files**:

| File | Written when | Default name | Override |
| --- | --- | --- | --- |
| local development record | no API key is configured (the key is the switch) | `log/test_results.local.jsonl` | `SPECGUARD_LOCAL_OUTPUT_PATH` |
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
re-sent — the numbering never shifts:

```bash
specguard-ingest --from-line 7 log/test_results.jsonl     # a suffix: skip lines 1-6
specguard-ingest --lines 3,7,12-15 log/test_results.jsonl # an explicit set over the same numbering
```

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
  one stderr warning naming what was held back.
- Held-back lines are **counted and reported** in the summary, with accurate singular/plural wording
  ("2 earlier lines skipped by --from-line", "1 line not selected by --lines", "1 blank line skipped") —
  a summary that quietly narrowed what it was summarising would be worse than no summary.
- Nothing about a line's **content** is consulted by either flag. The numbers come from you, after
  reading `--list`; that is what keeps this an explicit selector rather than the heuristic this command
  refuses to grow.

### The exit codes are the contract

| Code | Meaning |
| --- | --- |
| `0` | every line was accepted — including the vacuous empty file (a loud stderr warning, not a code) |
| `1` | at least one line was **refused by the endpoint** — it read the payload and said no (HTTP `400`, the one response the platform forms an opinion about a payload in) |
| `2` | this tool could not do its job — bad flags, no endpoint or API key, an unreadable file, an unparseable line, a delivery that never reached the endpoint, or one the endpoint answered without ever reading it (`401`, `404`, `429`, `5xx`: nothing was stored, so none of them is a verdict about your run) |

`2` dominates `1`: a file where line 3 was refused and line 7 never arrived exits `2`, because the second
fact is the one that leaves work undone — both are printed either way; the exit code chooses what to
shout, never what to say. With `--list` the only reachable codes are `0` (listed) and `2` (bad flag,
unreadable file): listing delivers nothing, so it can never carry a verdict about a run. The command
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
    reporters: ["default", "specguard-ts/vitest"],
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

1. **`location.line` points at the 1-based `test(` call line** — the same anchor `node:test` reports, so
   the annotation pass's one-line comment lookback (`ANNOTATION_LOOKBACK_LINES`) applies unchanged. The
   offset was re-measured on Vitest's coordinates rather than inherited: the comment sits exactly one
   line above `location.line`, pinned by a fixture test.
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
  reporters: ["default", "specguard-ts/jest"],
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
   report, so the annotation pass's one-line comment lookback (`ANNOTATION_LOOKBACK_LINES`) applies
   unchanged. The offset was re-measured on Jest's coordinates rather than inherited: the comment sits
   exactly one line above `location.line`, pinned by a fixture test.
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
  - run: node --test --test-reporter=./node_modules/specguard-ts/dist/node-test/reporter.js
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
| `branch` | string \| null | null on a detached checkout |
| `ci_run_id` | string \| null | **string, never a number** |
| `shard_id` | string \| null | **string, never a number** |
| `duration_seconds` | number \| null | non-negative |
| `specs` | array | **required** |

**Each spec** — one object per test that finished:

| Field | Type | Rule |
| --- | --- | --- |
| `file_path` | string | **required**, non-empty; project-relative |
| `line_number` | integer | **required**, positive — taken from the event's `line`, always present on `node:test` result events |
| `status` | `"annotated"` \| `"unannotated"` | always `"unannotated"` in this slice |
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
specguard lint --json     # machine-readable report on stdout
```

Point the client at a binary with `SPECGUARD_VALIDATE_INTENT=/path/to/validate-intent` (a path, not
a command name; see slice 2). Without a resolvable binary the command still works for repositories
that have nothing to check:

| Exit | Meaning |
|---|---|
| 0 | every annotation checked was valid — including "there were none" (a repo with zero annotations and no binary is still 0) |
| 1 | at least one annotation is malformed |
| 2 | the linter could not do its job — misuse, a broken override, an unresolvable binary when annotations exist, unreadable files, or a backend failure |

An exit-2 run writes its reason to stderr and emits **no report document** — "could not check" is
never dressed as an empty clean-looking report. `--json` replaces the stdout report only; the exit
code and stderr are identical on both paths.
