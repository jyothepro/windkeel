# Finish the live proof and build a factory benchmark (success rate + cost per task)

> ADR and migration numbers below are placeholders: use the next free number in `docs/adr/` and `migrations/` when implementing.

## Why

Devin AI and Factory.ai sell "an agent that ships PRs". Their public claims are success rates on
SWE-bench-style sets and on customer repos. Windkeel's edge is different: an **independent verifier**
(ADR-0004, ADR-0029 — *the verifier stays the gate; there is no path from an agent's change to a
delivered PR that does not pass verification*). To compete we must (a) prove the whole loop works
against real services, including the one property still unproven (repair turning `fail` into
`pass`), and (b) publish reproducible numbers: **verified success rate, false-accept rate, and USD
cost per task**. Without (b) the verifier is an unquantified claim.

## Background the implementer needs

Read these first (all real):

- `research/MILESTONES.md` — status table. Live status as of 2026-10-06:
  - M3 ✅ live `codex exec` in a real Vercel sandbox (five runs). **Leftover from #116 (closed
    early):** no real JSONL transcript captured as a fixture; cancellation unproven live.
    `test/fixtures/codex/*.jsonl` (`successful-session`, `failed-turn`, `resumed-turn`,
    `malformed-and-unknown`) are still hand-authored (see `docs/running-the-factory.md` ~line 433).
  - M4 ✅, M6 ✅ (draft PRs content-machine#90/#92; `pull_request.merged → COMPLETED` observed
    later in run `e81108b4`).
  - M5 ⚠️ **"Observed, not demonstrated"** — repair loop has never turned a `fail` into a `pass`
    live (runs `f28748b2`, `6d7151f5`, `db2bdce9`; verifier defects #227/#241/#246).
  - M9 ⚠️ BYOK code complete, not proven live (#318 spike open).
- `docs/archive/2026-11/roadmap-next-milestones.md` — "Milestone B — the live proof (#176, #116, #183)".
  #176 (accounts/setup), #116 (real codex), #183 (runbook from a real run) are **closed**; their
  leftovers are what this issue finishes.
- `docs/running-the-factory.md` — operator doc: `windkeel-admin doctor` (§Preflight), `windkeel submit`,
  `windkeel capture <run-id>` (copies sandbox scratch dir → evidence bucket `captures/<run-id>/`),
  `windkeel metrics`, `windkeel reap`, troubleshooting table, env vars (`WINDKEEL_CODEX_VERSION`,
  `WINDKEEL_ALLOW_CODEX_VERSION_DRIFT`, `WINDKEEL_SANDBOX_*`, `WINDKEEL_MAKER_MODEL`, `WINDKEEL_REVIEW_MODEL`,
  `WINDKEEL_USD_PER_*_TOKEN`, `WINDKEEL_WORKFLOW_BACKING`, `S3_BUCKET`, `CRON_SECRET`).
- `docs/github-app.md` — App permissions (ADR-0009, least privilege).

Code seams:

- Worker: `src/worker/adapter.ts` (`WorkerAdapter`, `WorkerEvent`, `WorkerUsage`, `WorkerResult`,
  `WorkerOutcome = "completed"|"failed"|"cancelled"`, `WorkerSessionRef`);
  `src/worker/codex/adapter.ts` (`PINNED_CODEX_VERSION = "0.154.0"`, `allowVersionDrift`,
  `cancel()` signals the recorded process group); `src/worker/codex/events.ts` (JSONL normalizer,
  `onDiagnostic`). Fakes: `src/worker/fake.ts`, `src/worker/scripted.ts` (`ScriptedWorkerAdapter`).
- Sandbox: `src/sandbox/provider.ts` (`SandboxProvider`, `SandboxRole = "maker"|"verifier"`),
  `src/sandbox/vercel.ts` (`VercelSandboxProvider`), `src/sandbox/fake.ts` (`FakeSandboxProvider`).
- Orchestration: `src/factory/workflow/` (Vercel Workflow, ADR-0021; `vercel.ts`, `vercel-flow.ts`,
  `handlers/*`), run state machine `src/factory/run-state-machine.ts`, `src/factory/run-capture.ts`,
  `src/factory/run-report.ts`, `src/factory/metrics.ts`, `src/factory/cost-ledger.ts` (ADR-0013).
- Metrics views: `migrations/0002_metrics_views.sql` (`task_success_rate`,
  `first_pass_verification_rate`, `repair_success_rate`, `merge_rate`, `time_to_pr`,
  `sandbox_duration`, `model_tokens`), revised in `0004_…`; cost by key source `0031_cost_key_source.sql`.
  Latest migration is `0036_run_merge_claim.sql`.
- Existing bench: `packages/cli/src/commands/bench.ts` (`BenchCase`, `BenchReport`, `runBench`,
  `formatReport`) scores the **verifier only** over `bench/corpus/NN-*/{base,head,case.json}`
  (catch rate / false-positive rate). `packages/cli/src/commands/replay.ts` + `bench/replay/`
  (README, RESULTS.md, `cases/`) replays real OSS PRs (needs network + reviewer key; not in CI).
  Tests: `test/bench.test.js`, `test/replay.test.js`, `test/corpus-coverage.test.js`. CLI wiring in
  `packages/cli/src/cli.ts` (`command === "bench"` / `"replay"`).
- Tests: `node --test` over `test/*.test.js` against built `dist/`; `npm test` cleans+builds.
  Helpers `test/helpers.js` (`runCli`, `tempDir`, `fixtureRepo`, `bareFixtureRepo`,
  `codexFixture`, `installStubCodex`, `makerSandbox`, `adapterFor`, `TEST_POOL`),
  `test/factory-stack.js`, `test/github-stub.js`, `test/workflow-runtime.js`. E2E pattern:
  `test/e2e-github-loop.test.js` (signed webhook → real ingress handler → real Postgres → real
  stage handlers, fakes at edges). Browser tests: `test/console-browser.js` (playwright-core).

ADRs (1–2 lines each):
- **0004** verification runs in a fresh independent sandbox; maker never touches the verifier.
- **0010** maker and checker vendors must differ (`selectGateway` refuses a match).
- **0011** repair-loop caps and safety rails (max attempts, stuck detection, cost caps).
- **0013** cost ledger + SQL views are the observability source of truth.
- **0014** keys brokered at egress; sandbox sees placeholders only.
- **0016** local dev is hermetic by default: CI never touches a real external service; live
  checks are opt-in.
- **0020/0021** control plane is Vercel end to end; Vercel Workflow backs `WorkflowProvider`.
- **0029** Windkeel is an integrated coding assistant; the verifier stays the gate — no path around it.

## Scope

In:
1. A recorded live run that **demonstrates M5**: a genuinely broken first candidate, a repair,
   a re-verification `pass`, a verified draft PR.
2. #116 leftovers: a real Codex JSONL transcript as fixtures; live cancellation proof; normalizer
   fixes the real stream forces.
3. Runbook/status updates (#183 follow-through) only for what is observed.
4. A **factory benchmark** (`windkeel bench-factory`, new) that runs whole tasks end to end and
   reports success rate, verified-false-accept rate, cost and time per task, over (a) a small
   SWE-bench-style set and (b) real scratch repos.

Out: new worker harnesses (10-multi-harness), environment snapshots (02), parallel runs (06),
browser use (07), billing (09), proving M9 BYOK live (#318), any leaderboard submission.

## Design

### Benchmark data model (files, not DB — no migration needed)

New dir `bench/factory/` :
```
bench/factory/README.md            # how to run, what counts as success, honesty rules
bench/factory/RESULTS.md           # recorded runs (like bench/replay/RESULTS.md)
bench/factory/tasks/<id>/task.json # one per task
```
`task.json` (new type `FactoryBenchTask` in new file `packages/cli/src/commands/bench-factory.ts`):
```jsonc
{
  "id": "swe-astropy-12907",          // or "repo-content-machine-strip-md"
  "source": "swe-bench" | "real-repo",
  "repository": "https://github.com/<owner>/<repo>",   // scratch fork for swe-bench
  "base_ref": "<sha>",
  "title": "…", "description": "…",   // becomes windkeel submit --title/--description
  "acceptance_criteria": ["…"],       // optional; else ADR-0012 extract/generate
  "hidden_tests": { "command": "…", "files": ["path…"] },  // ground truth, NEVER given to maker or verifier
  "budget_usd": 2.0, "timeout_minutes": 45
}
```
Hidden tests are applied *after* the run, in a separate checkout, to the PR head. This is what
lets us measure the verifier's **false-accept rate** (verifier `pass`, hidden tests fail) —
the number that substantiates ADR-0029.

### Result record (`BenchFactoryReport`)
Per task: `run_id`, final run state, `verdict` (verifier), `hidden_tests` (`pass|fail|not_run`),
`repair_turns`, `cost_usd` (from cost ledger via `GET` run report / `windkeel show --json`),
`wall_seconds`, `pr_url`. Aggregates:
- `success_rate` = tasks with verifier pass **and** hidden tests pass / tasks attempted
- `verified_false_accept_rate` = verifier pass ∧ hidden fail / verifier pass
- `verified_false_reject_rate` = verifier fail ∧ hidden pass / verifier fail (stuck/refused runs)
- `repair_conversion_rate` = runs whose first verification failed and later passed / those that failed first
- `cost_per_task_usd` (mean, p50, p90), `cost_per_success_usd` = total cost / successes
- `excluded` list with reasons (infra error ≠ agent failure; never silently dropped).

### CLI
New command in published CLI `packages/cli/src/cli.ts`:
```
windkeel bench-factory [<tasks-dir>] [--json] [--out <dir>] [--only <id,…>] [--concurrency 1]
                    [--dry-run]
```
It talks to a deployment through the existing API client (`packages/cli/src/client/`,
`WINDKEEL_API_URL`, `WINDKEEL_API_TOKEN`): submit → poll run → read report/cost → then runs hidden tests
locally in a temp clone of the PR branch. `--dry-run` validates tasks and prints the plan without
submitting. It never bypasses verification: it only reads outcomes. Default concurrency 1.

### Safety / config
- Live runs only when `WINDKEEL_API_URL` set; refuse to target the `windkeel` repo itself.
- Per-task `budget_usd` passed as the run's cost cap (ADR-0011 rails) — if the submit API lacks a
  cost-cap field, enforce client-side by cancelling and record `excluded: budget`.
- Hidden test files must never be committed to the scratch repo branch the maker sees.
- Never print tokens; redact via existing `src/sandbox/redact.ts` patterns if logging env.

## Implementation steps

Split into three sub-tasks (separate PRs).

### Sub-task A — #116 leftovers: real Codex transcript fixtures + cancellation (ready-for-human for the live part, agent for code)
1. Human/operator: on the live deployment, `windkeel submit` a trivial task to the scratch repo; while
   the maker sandbox is alive run `windkeel capture <run-id>`. Also run one task and cancel it mid-turn
   (the run cancel intent via API/console) and capture that too.
2. Copy transcripts to new fixtures `test/fixtures/codex/live-successful-session.jsonl`,
   `live-resumed-turn.jsonl`, `live-cancelled-turn.jsonl` (scrub any secret; grep for `sk-`, `ghs_`).
3. Agent: add tests feeding them through `normalizeCodexStream` (src/worker/codex/events.ts); fix
   any field spellings (`item_type` vs `type`, `exit_code`, `changes[].kind`, `usage` keys) the
   real stream reveals; zero unknown-item diagnostics for known item kinds.
4. Confirm `PINNED_CODEX_VERSION` matches `codex --version` in the captured session; update if not.
5. Update `docs/running-the-factory.md` (~line 433 paragraph) and `research/MILESTONES.md` M3 row:
   drop the caveat only for what was captured.

Done: live fixtures present and tested; cancellation behaviour recorded (orphan check: after
cancel, `windkeel reap --dry-run` shows no stray sandbox and capture shows process exited).

### Sub-task B — Demonstrate M5 live (ready-for-human; agent assists with task design)
1. Create in the scratch repo an issue whose first naive implementation is genuinely wrong but
   catchable by the repo's own tests (e.g. a function with an edge case covered by an existing
   failing-on-naive test; acceptance criterion names the edge case). Precompute: naive fix fails
   `npm test`, correct fix passes.
2. Label the issue `windkeel`; watch with `windkeel show <run-id>`; `windkeel capture` before teardown.
3. Accept only if run transitions VERIFYING(fail) → REPAIRING → VERIFYING(pass) → PR, and an
   independent off-machine check of the PR head passes `npm test`.
4. Update `research/MILESTONES.md` M5 row and "What M5 actually landed"; add any new failure to the
   troubleshooting table in `docs/running-the-factory.md`. Record run id, cost, duration.
If 3 attempts fail to converge, record them honestly and open a follow-up; do not mark M5 done.

### Sub-task C — Factory benchmark harness (ready-for-agent)
1. New file `packages/cli/src/commands/bench-factory.ts`: types, `loadTasks(dir)` with validation
   (unique ids, required fields, `source` enum, positive budget), `scoreFactoryBench(results)` pure
   aggregate function, `formatFactoryReport`.
2. `runFactoryBench(tasks, deps)` with injected `deps = { client, runHiddenTests, clock }` so tests
   use fakes; real `client` is the existing API client.
3. `runHiddenTests(prHeadSha, task)` (new, same file or `bench-factory-hidden.ts`): clone to
   `tempDir`, checkout PR head, copy hidden test files, run command with timeout; `not_run` on infra
   error.
4. Wire `bench-factory` into `packages/cli/src/cli.ts` usage + dispatch, mirroring `bench`/`replay`.
5. Seed `bench/factory/tasks/` with ≥5 SWE-bench-style tasks (small Python/JS repos pinned at a base
   SHA, with the upstream fix's tests as hidden tests; license must permit) and ≥3 real-repo tasks
   on the scratch repo(s). Write `bench/factory/README.md` (success definitions, exclusion rules,
   "observational, not CI", ADR-0016).
6. Operator runs it live once; commit output to `bench/factory/RESULTS.md` with date, deployment
   commit, maker/checker models, totals.

## Done condition

- [ ] `test/fixtures/codex/live-*.jsonl` exist, sourced from a real capture (README note or header
      comment in test cites run ids), and pass through the normalizer with no unknown diagnostics.
- [ ] Live cancellation observed: outcome `cancelled`, no orphan sandbox, recorded in docs.
- [ ] A live run id is recorded in `research/MILESTONES.md` showing fail → repair → pass → draft PR;
      M5 row upgraded **only** if so (else explicitly still ⚠️ with the new attempts listed).
- [ ] `windkeel bench-factory --dry-run bench/factory/tasks` exits 0 and lists ≥8 tasks.
- [ ] `windkeel bench-factory --json` report contains `success_rate`, `verified_false_accept_rate`,
      `verified_false_reject_rate`, `repair_conversion_rate`, `cost_per_task_usd`,
      `cost_per_success_usd`, `excluded`.
- [ ] `bench/factory/RESULTS.md` holds one real recorded run.
- [ ] `npm test` passes; no test calls a real external service (ADR-0016).

## How to verify the done condition

```sh
npm test                                              # all green, offline
node --test test/worker-codex-events.test.js test/bench-factory.test.js test/e2e-bench-factory.test.js
node packages/cli/dist/cli.js bench-factory bench/factory/tasks --dry-run      # lists tasks, exit 0
# live (operator, with WINDKEEL_API_URL / WINDKEEL_API_TOKEN for the deployment):
windkeel-admin doctor                                    # all green first
windkeel bench-factory bench/factory/tasks --json --out /tmp/bf > /tmp/bf/report.json
jq '.success_rate, .cost_per_task_usd, .verified_false_accept_rate' /tmp/bf/report.json
windkeel show <m5-run-id>                                # state history shows VERIFYING fail → REPAIRING → pass
windkeel reap --dry-run                                  # nothing left billing
```
Proof = recorded run ids + report JSON committed in RESULTS.md, and green `npm test`.

## Tests required

Unit:
- `test/worker-codex-events.test.js` (extend): each `live-*.jsonl` normalizes to expected
  `WorkerEvent`s (file_changed, command, test_finished, usage); usage token totals match the
  transcript's final usage line; cancelled transcript ends with outcome `cancelled`; truncated last
  line tolerated (watermark, see `test/worker-watermark.test.js`).
- `test/worker-codex-adapter.test.js` (extend if version/flags changed): pinned version parse
  against the real `codex --version` string captured.
- `test/bench-factory.test.js` (new): `loadTasks` rejects duplicate id, missing repository, bad
  source, non-positive budget, hidden test path escaping the task dir (`../`); `scoreFactoryBench`
  math incl. zero denominators (follow `ratio(..., whenEmpty)` convention in bench.ts), excluded
  tasks not counted, cost p50/p90 with one task; refusal to target the windkeel repo; formatter output.
- `test/bench-factory-hidden.test.js` (new): hidden tests run against a `bareFixtureRepo` head —
  pass, fail, timeout → `not_run`, missing command → `not_run`.

Integration / e2e:
- `test/e2e-bench-factory.test.js` (new): build on `test/factory-stack.js` / patterns from
  `test/e2e-github-loop.test.js` with real Postgres, `FakeSandboxProvider`, `ScriptedWorkerAdapter`
  and `FakeGitHubClient`. Scenarios: (1) first candidate passes verification and hidden tests →
  success; (2) scripted bad candidate, repair fixes → counted in `repair_conversion_rate`;
  (3) verifier pass but hidden tests fail → false accept; (4) stuck run → false reject when hidden
  tests would pass on the correct patch, else plain failure; (5) budget exceeded → excluded with
  reason. Assert cost numbers equal cost-ledger sums.
- CLI test via `runCli(["bench-factory", dir, "--dry-run", "--json"])` in `test/bench-factory.test.js`.

Browser: none required.

## Risks & open questions

- **SWE-bench licensing/size**: full SWE-bench is Python-heavy and needs per-repo envs (overlaps
  02-environment-snapshots). Default: start with ≤10 small, permissively licensed tasks (SWE-bench
  Lite subset or hand-built JS equivalents); don't claim SWE-bench numbers, call it "SWE-bench-style".
- **Cost**: each live task ~$0.10–$0.30 per observed runs; default cap $2/task, $50/run total — human
  must approve spend.
- **Hidden-test leakage**: if acceptance criteria quote hidden tests, results are inflated. Default:
  criteria written from the issue text only; review in PR.
- **Run cost cap API**: unknown whether `submit` accepts a per-run cost cap; default client-side
  cancel, open a follow-up if needed.
- **M5 may not converge** — verifier defects previously masked it. Human decides whether a task
  designed to fail first is a fair demonstration (default: yes, if naive failure is genuine and
  checked off-machine).
- Where the benchmark runs (operator laptop vs scheduled) — default operator laptop, manual.

## Suggested labels and dependencies

- Sub-task A: `ready-for-human` (capture) then `ready-for-agent` (fixtures/normalizer).
- Sub-task B: `ready-for-human`.
- Sub-task C: `ready-for-agent` for code + offline tests; live RESULTS.md run is `ready-for-human`.
- Blocked-by: none. Blocks/feeds: 02-environment-snapshots (SWE-bench envs), 05-agent-types-playbooks,
  06-parallel-and-batch (`--concurrency`), 10-multi-harness (bench compares harnesses).
