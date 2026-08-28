# specguard-ts

> The TypeScript client for [SpecGuard](https://github.com/yatfa-ai/specguard): a Vitest/Jest reporter that
> ships test-run telemetry, and a CLI linter that validates `@intent` annotations.

Two independent tools, one dependency — the [OpenTestIntent](https://github.com/yatfa-ai/open-test-intent) annotation
format. A third command, [`specguard-ingest`](#replaying-a-saved-run--specguard-ingest), belongs to the first of them:
it replays a run the reporter saved when the endpoint could not be reached.

The shape deliberately mirrors [`specguard-rspec`](https://github.com/yatfa-ai/specguard-rspec), the Ruby client.
Same three tools, same environment variables, same wire contract — a team running both languages against one SpecGuard
deployment configures them identically, and the two clients are distinguishable on the platform only by `User-Agent`.

---

## Status

**This repository is a specification, not yet an implementation.** Nothing is published to npm and no code is written.
This README is the contract the implementation is held to: the wire format below is read from SpecGuard's own
`Ingest::Payload` validator and is authoritative; everything describing *this client's* behaviour is a target, not a
description of something running.

Sections marked **[open]** are decisions the implementation still has to make.

---

## Install

```bash
npm install --save-dev specguard-ts
```

The package is ESM-first, ships its own type declarations, and targets Node 20+. It has no runtime dependency on
Vitest or Jest — both are optional peers, so installing it does not drag in the runner you are not using.

## The linter — `specguard-lint`

Validates `// @intent:` annotations in changed (or all) test files against the OpenTestIntent JSON Schema. Exits `1` on
a malformed annotation; **never** fails on a *missing* one (adoption is opt-in and gradual).

```bash
npx specguard-lint --changed   # CI mode: only files in the current diff
npx specguard-lint             # one-off audit: every test file
```

Files are **positional** (`specguard-lint src/order.test.ts`). The default glob covers the conventional suffixes —
`*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx`, and their `.js`/`.jsx` siblings.

The annotation is the same single comment line every OpenTestIntent consumer reads, in JavaScript comment syntax:

```ts
// @intent: { entity: "Order", action: "refund", behavior: "restores stock levels on refund", layer: "unit" }
it("restores stock levels", async () => { /* … */ })
```

Both `//` and `/* … */` forms are accepted. The annotation attaches to the **next** test declaration below it, which is
the same rule the Ruby linter applies.

### Machine-readable output (`--json`)

The human report is for humans. `--json` emits one JSON document on stdout instead, so a CI step or an agent gets
*which file, which line, which rule* as data rather than a prose format to regex:

```bash
npx specguard-lint --json src/order.test.ts
```
```json
{
  "schema": "open-test-intent.v1.json",
  "mode": "source",
  "ok": false,
  "summary": { "files": 1, "annotations": 2, "failed": 1 },
  "findings": [
    { "file": "src/order.test.ts", "line": 24, "ok": false, "kind": "schema",
      "errors": ["<root>: additional property 'entiity' is not allowed"] }
  ]
}
```

The linter sends nothing anywhere. It is a separate program from the reporter and needs no API key.

**[open]** Which JSON Schema validator to depend on. Whatever is chosen must be pinned, and the linter must render its
reason lines from the validator's *structured* error fields rather than its prose, so a dependency bump cannot silently
change what `specguard-lint` reports. This is the constraint `specguard-rspec` pins `json_schemer` for.

## The reporter

An additive reporter: it observes the run and reports it, and it does not replace the reporter you read.

### Vitest

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // REQUIRED — see "Line numbers are not free" below.
    includeTaskLocation: true,
    reporters: ["default", "specguard-ts/vitest"],
  },
})
```

### Jest

```js
// jest.config.js
module.exports = {
  reporters: ["default", "specguard-ts/jest"],
  // REQUIRED — see "Line numbers are not free" below.
  testLocationInResults: true,
}
```

### Line numbers are not free

`line_number` is **required** by the ingest endpoint and must be a positive integer — a payload without it is rejected
per-spec with a `400`. Neither runner reports it by default:

| Runner | Flag | Without it |
| --- | --- | --- |
| Vitest | `includeTaskLocation: true` (or `--includeTaskLocation`) | `task.location` is `undefined` |
| Jest | `testLocationInResults: true` (or `--testLocationInResults`) | `assertionResult.location` is `null` |

So the reporter cannot simply read a location and send it. Two things follow, and both are requirements rather than
suggestions:

1. **The reporter must detect the missing setting and say so once, on stderr, naming the flag to set.** Silently
   dropping the run, or sending a placeholder line number, are both worse than a line of output.
2. **The annotation scanner already parses the test file** to find `@intent:` comments, and that parse knows which line
   each test declaration is on. **[open]** Whether that is an acceptable fallback for `line_number` when the runner
   reports no location, or whether the flag stays a hard requirement. The scanner's line is the *declaration* site,
   which is what the Ruby client sends anyway (`metadata[:line_number]`), so the two agree — but a scanner that fails to
   parse an exotic file would then produce a rejected payload from a run that had a perfectly good location available.

### Example ids must be stable

`id` is the upsert key: SpecGuard writes one observation row per `(test_run_id, example_id)` and a repeated id inside
one delivery is collapsed to its first occurrence. It is the field that lets a re-run **replace** an example's numbers
rather than duplicate them, and it is the one per-example field the endpoint does **not** validate — a client that
sends an unstable id corrupts its own history and gets no error saying so.

RSpec hands its client `./spec/orders_spec.rb[1:2]` for free. Neither Vitest nor Jest has an equivalent, so this client
has to compose one. **[open]** The composition. It must be stable across runs for an unchanged test, stable across
shards, and independent of execution order — the obvious candidate is the file path (on the same project-relative terms
as `file_path`) plus the full test name path, and the obvious trap is anything derived from an index into the run.

## Shipping the run to SpecGuard

Set an API key and an endpoint and the run is POSTed to `<endpoint>/api/v1/ingest` — once per process, as a single
request:

```bash
export SPECGUARD_ENDPOINT=https://specguard.example.com
export SPECGUARD_API_KEY=sgk_…      # from your repository's settings
export SPECGUARD_TIMEOUT=10         # optional; seconds, applied to connect and read
```

The same four variables the Ruby client reads, with the same meanings — plus `SPECGUARD_OUTPUT_PATH` for the local
sink. A project running both clients configures them once.

**The API key is the switch.** With no key nothing is sent anywhere and the run is written to
`log/test_results.jsonl`, so local development needs no opt-out and a fork with no secret configured behaves like a
laptop rather than like a broken build.

**A failed delivery is never silent, and never lost.** If the endpoint refuses the run (a `401` from a rotated key, a
`400`, a `500`) or cannot be reached at all, the reporter prints **one** line to stderr naming the status or the error,
and writes the payload to `log/test_results.jsonl` so the run can be replayed later:

```
SpecGuard: could not deliver test telemetry (HTTP 401 — the API key was not
accepted). Falling back to log/test_results.jsonl; the test run is unaffected.
```

That line carries the endpoint's own words when it has any — a `400` names the offending spec by index, file and line,
so a rejected payload is fixable from the CI log. It stays **one** line whatever comes back: at most three reasons are
spelled out and the rest are counted (`… and 497 more`).

There are **no retries**, and the whole delivery is bounded by the timeout (10 seconds by default): telemetry is
explicitly allowed to be lost, and a retry would only double what a hung endpoint can cost your CI run.

It **never fails the run.** Every reporter hook catches, warns once on stderr, and leaves the exit status to your suite
alone. A non-2xx response is checked for explicitly rather than left to a `catch` — `fetch` resolves a `401` as an
ordinary response, so a wrong API key throws nothing and would otherwise disappear in complete silence.

**[open]** The dry-run analogue. `specguard-rspec` refuses to publish `rspec --dry-run`, because the durations and
outcomes it fabricates would poison both headline numbers. Vitest and Jest have no exact equivalent, but they do have
near-misses that produce the same shape of corrupt data — a fully-mocked or `--listTests`-style invocation, or a run
where every test is skipped. Decide what, if anything, this client refuses.

### Replaying a saved run — `specguard-ingest`

The suite is over by the time you see the `401`, and re-running it to recover the telemetry costs you the whole suite
again. So the file the reporter wrote **is** the run: each line is byte-for-byte the body the endpoint refused.

```bash
export SPECGUARD_API_KEY=…            # the key that was rotated, fixed
npx specguard-ingest log/test_results.jsonl
```

```
line 1: accepted — HTTP 202, test_run_id 41f2c9b8, ci_run_id 17442
specguard-ingest: delivered 1 of 1 runs from log/test_results.jsonl
```

> **It re-delivers *every* line in the file you give it.** The reporter writes to `log/test_results.jsonl` when a
> delivery **failed** *and* when no API key was configured at all — and the two are indistinguishable on the line,
> because nothing in the payload records which sink it was destined for. Check the file with `--list` first, which
> prints one row per line and delivers nothing.

## If you shard your suite

Both runners shard natively (`vitest --shard=1/4`, `jest --shard=1/4`), and a CI matrix shards on top of that. Each
process loads the reporter and POSTs its own slice; `ci_run_id` is what tells SpecGuard those POSTs are **one run**, so
a 20,000-test suite reports a 20,000 denominator instead of four records holding a quarter each.

Every supported provider publishes a build id, so a sharded job needs no configuration:

| Field | Resolved from |
| --- | --- |
| `ci_run_id` | `SPECGUARD_RUN_ID`, else `GITHUB_RUN_ID`, `CI_PIPELINE_ID`, `CIRCLE_WORKFLOW_ID`, `BUILDKITE_BUILD_ID`, `BUILD_TAG` |
| `shard_id` | `SPECGUARD_SHARD_ID`, else `CI_NODE_INDEX`, `CIRCLE_NODE_INDEX`, `BUILDKITE_PARALLEL_JOB` |

A shard must be able to **replace** its own earlier numbers rather than add to them, which means naming itself — press
"re-run failed jobs" and only the failed shards run again, inside the same `ci_run_id`. Leaving `shard_id` unset is not
an error and does not lose the slice; what it cannot do is be recognised on a second delivery.

**GitHub Actions `matrix:` needs a line of config** — it exports no per-leg index:

```yaml
strategy:
  matrix:
    shard: [1, 2, 3, 4]
steps:
  - run: npx vitest --shard=${{ matrix.shard }}/4
    env:
      SPECGUARD_SHARD_ID: ${{ matrix.shard }}
```

**[open]** Whether to read the runner's own `--shard` argument as a fallback. Both runners know their shard index and
neither exports it to the environment; reading `process.argv` would cover the plain `vitest --shard=1/4` case that the
table above misses. `TEST_ENV_NUMBER` is in the Ruby client's list because `parallel_tests` is a Ruby tool — it does not
belong here.

## The wire contract

`POST <endpoint>/api/v1/ingest`, `Authorization: Bearer sgk_…`, `Content-Type: application/json`. A body over
**256 KiB** is gzipped with `Content-Encoding: gzip` — that threshold is the Ruby client's, and matching it keeps the
two clients' behaviour on a large suite the same. Success is **`202 Accepted`**:

```json
{ "test_run_id": "41f2c9b8", "total_specs": 812, "annotated_specs": 190,
  "annotated_ratio": 0.234, "embedding_status": "queued" }
```

`annotated_ratio` is a 0–1 fraction. The counts are **derived server-side** from `specs[]` and are never read from the
client — do not send them.

**The envelope**, once per process:

| Field | Type | Rule |
| --- | --- | --- |
| `commit_sha` | string | **required**, non-empty |
| `branch` | string \| null | null on a detached checkout |
| `ci_run_id` | string \| null | **string, never a number** — see below |
| `shard_id` | string \| null | **string, never a number** — see below |
| `duration_seconds` | number \| null | non-negative |
| `specs` | array | **required** |

`ci_run_id` and `shard_id` are refused as JSON numbers rather than coerced, and this matters more in TypeScript than it
did in Ruby: `GITHUB_RUN_ID` arrives as a string from the environment, but a shard index composed in code
(`shard: [1, 2, 3, 4]`, an array index, a `--shard` parse) is a `number`, and `JSON.stringify` will happily emit `0`.
`0` and `"0"` key different shards of one run, which would let a shard fail to replace itself. **Stringify both at the
edge.**

**Each spec** — one object per test that finished, annotated or not:

| Field | Type | Rule |
| --- | --- | --- |
| `file_path` | string | **required**, non-empty; project-relative when under the root |
| `line_number` | integer | **required**, positive |
| `status` | `"annotated"` \| `"unannotated"` | **required** |
| `intent` | object \| null | **required** when annotated, **must be null** when unannotated |
| `name` | string | non-empty; **required when the spec carries no intent** |
| `duration` | number \| null | non-negative, seconds |
| `id` | string | the upsert key — unvalidated, and stability is on you |
| `spec_file_path` | string | the file that *ran* the test; falls back to `file_path` |
| `outcome` | string | free text, echoed back verbatim |

A run with **zero** annotations is valid — missing annotations are never an ingestion failure, only malformed ones are.
What every spec owes is *something that represents it*: an intent or a `name`.

`duration` is **seconds**, not milliseconds. Both runners report milliseconds, so the reporter divides — and this is the
single easiest way for this client to silently corrupt the platform, because a duration is summed, ranked and averaged
without anything downstream able to tell it was off by 1000×.

`outcome` is unvalidated by the endpoint, which makes it the client's job to be consistent: send `passed`, `failed`,
`pending` — the same three words the Ruby client sends — so that a mixed-language project aggregates. Map Vitest's
`pass`/`fail`/`skip`/`todo` and Jest's `passed`/`failed`/`pending`/`todo`/`disabled` onto that vocabulary rather than
forwarding them raw.

Every failure is collected rather than raised on the first one, and every per-spec message names the spec it came from,
so a `400` lists the whole problem at once.

## What SpecGuard collects

The tables above **are** the request body — there is no filtering layer between what the reporter captures and what
leaves the machine. Two request headers say something about you rather than about the request: the API key travels as a
bearer token in `Authorization`, and `User-Agent` names this package and its version (`specguard-ts/<version>`), so the
platform can tell its clients apart.

Test names, `@intent` annotations and file paths are written by your developers, in prose, and **will** carry internal
product detail — because a suite describes the system it tests. SpecGuard is built on that and cannot be built without
it. There is no opt-out and no field-level redaction.

### If this cannot leave your perimeter, run SpecGuard inside it

Self-hosting needs no code change — point `SPECGUARD_ENDPOINT` at your own deployment.

### What is never collected

- **No source code.** Not your application's, and not your tests' — no test body, no fixture, no diff.
- **No failure messages and no stack traces.** A failing test contributes the string `failed` and nothing else.
- **No console output.** Nothing your suite printed, and nothing any other reporter wrote, is read or forwarded.
- **No environment.** A fixed list of variables is read and no others: the ones that fill `commit_sha`, `branch`,
  `ci_run_id` and `shard_id`, plus four that configure the client itself — `SPECGUARD_ENDPOINT`,
  `SPECGUARD_OUTPUT_PATH`, `SPECGUARD_TIMEOUT`, and `SPECGUARD_API_KEY`, which leaves the machine only as the bearer
  token above.
- **Proxy settings are read, and this is the one exception** — they decide only *where* the run goes, never what is in
  it. **[open]** Node's `fetch` (undici) does **not** honour `http_proxy`/`https_proxy` the way Ruby's `Net::HTTP`
  does; a proxied network needs an explicit `ProxyAgent`. Decide whether this client reads those variables itself, and
  document whichever way it lands — the Ruby client's behaviour here is not free.

---

<p align="center">
  <a href="https://yatfa.com">
    <img src="assets/built-with-yatfa.png" alt="Built with yatfa — a team of AI agents that plans, builds &amp; ships software." width="100%">
  </a>
</p>
