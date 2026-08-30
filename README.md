# specguard-ts

> The TypeScript client for [SpecGuard](https://github.com/yatfa-ai/specguard): `node:test` and Vitest
> reporters that ship test-run telemetry.

The shape deliberately mirrors [`specguard-rspec`](https://github.com/yatfa-ai/specguard-rspec), the Ruby
client: same environment variables, same wire contract — a team running both languages against one SpecGuard
deployment configures them identically, and the two clients are distinguishable on the platform only by
`User-Agent` (`specguard-ts/<version>`).

**This slice ships the node:test and Vitest reporters and the `specguard lint` command.** The Jest adapter and the
`specguard-ingest` replay command come with later slices of the build plan. The reporter reads **no
`@intent:` annotations on the telemetry path**: every run it ships may be a zero-annotation
run, which is valid by construction and is the platform's primary path.

---

## Status

Implemented and tested in this repository: a runner-agnostic core (envelope construction, per-example row
shape, stable id composition, transport with the never-fail guarantee), the `node:test` adapter, the
Vitest adapter, and the `specguard lint` command, all built on that core — the Vitest adapter reuses it
without a single core change, which was the architecture's acceptance test. Not yet implemented: the Jest
adapter, npm publishing.

The wire format below is read from SpecGuard's own `Ingest::Payload` validator and is authoritative.

---

## Install

```bash
npm install --save-dev specguard-ts
```

The package is ESM-first, ships its own type declarations, and targets Node 20+. It has no runtime
dependency on anything — `node:test` is part of Node itself, and Vitest is an **optional peer**:
installing this package into a `node:test` project pulls in no Vitest and warns about nothing.

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
`log/test_results.jsonl`, so local development needs no opt-out and a fork with no secret configured
behaves like a laptop rather than like a broken build.

**A failed delivery is never silent, and never lost.** If the endpoint refuses the run (a `401` from a
rotated key, a `400`, a `500`) or cannot be reached at all, the reporter prints **one** line to stderr
naming the status or the error, and appends the payload to `log/test_results.jsonl`:

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
  `branch`, `ci_run_id` and `shard_id`, plus four that configure the client itself — `SPECGUARD_ENDPOINT`,
  `SPECGUARD_OUTPUT_PATH`, `SPECGUARD_TIMEOUT`, and `SPECGUARD_API_KEY`, which leaves the machine only as
  the bearer token above.
- **Proxy settings are read, and this is the one exception** — they decide only *where* the run goes,
  never what is in it.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # compiles src+test, runs node --test
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
Vitest. To exercise them locally: `npm install --no-save vitest` and run `npm test` again (CI does exactly
this).

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
