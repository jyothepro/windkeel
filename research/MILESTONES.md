# Milestone Status

Status snapshot of the roadmap defined in [`direction-change/PLAN.md`](direction-change/PLAN.md) (§23).
Decisions are recorded as ADRs in [`docs/adr/`](../docs/adr/); open decision tickets live on the
[wayfinder map (#50)](https://github.com/jyothepro/orqon/issues/50).

_Last updated: 2026-10-06 (M9 code complete, not proven live; M7 done; M7–M15 reordered — see [the 2026-09-23 reordering](#the-2026-09-23-reordering))_

## Route to Milestone 6 (current effort)

| Milestone | Delivers | Status |
|---|---|---|
| **M0** — Verification kernel | Evidence-based PR gate: engine, CLI, bench corpus, replay harness | ✅ Done (PR #70) |
| **M1** — Factory domain model | Postgres schema + persistence for runs/attempts per [ADR-0003](../docs/adr/0003-factory-domain-model-and-run-state-machine.md) | ✅ Done (PRs #85–#95, CI wiring #96) |
| **M2** — Sandbox abstraction | Vercel Sandbox provider behind `ExecutionEnvironment` ([ADR-0004](../docs/adr/0004-verification-runs-in-a-fresh-independent-sandbox.md), [ADR-0014](../docs/adr/0014-sandbox-secrets-brokered-keys-scoped-tokens-phased-egress.md)) | ✅ Done (PRs #103–#108) |
| **M3** — First worker adapter | Codex adapter (`codex exec --json`) + command-classification shim ([ADR-0006](../docs/adr/0006-codex-is-the-first-worker.md)) | ✅ **Done** — five live runs drove a real `codex exec` in a real Vercel sandbox (2026-09-19 to 09-22). `codex exec resume` works across repair turns. Remaining under [#116](https://github.com/jyothepro/orqon/issues/116): a real JSONL transcript captured as a fixture, and cancellation. The importer and the tests that will hold a capture are in place ([#386](https://github.com/jyothepro/orqon/issues/386)); the capture is still an operator step |
| **M4** — First full autonomous loop | Control plane + orchestration wiring; monorepo split lands here ([ADR-0005](../docs/adr/0005-monorepo-split-lands-with-the-control-plane.md), ADR-0007 → [ADR-0021](../docs/adr/0021-vercel-workflow-backs-workflowprovider.md)) | ✅ **Done** — a local task produced a verified code change against real Postgres, a real sandbox and a real worker. The backing is now Vercel Workflow; ADR-0007 is superseded |
| **M5** — Autonomous repair | VERIFYING→REPAIRING cycle using the existing `RepairPacket` ([ADR-0011](../docs/adr/0011-repair-loop-policy-and-run-safety-rails.md), [ADR-0017](../docs/adr/0017-the-maker-outlives-verification-while-the-repair-loop-has-budget.md)) | ⚠️ **Observed, not demonstrated** — the loop has run live six times across four runs and has **never turned a `fail` into a `pass`**. Sessions resume, packets are built, candidates are produced, and the rails stop it correctly. What is unproven is the thing the milestone claims. A task built to fail first on the repository's own tests is ready for the live attempt ([#386](https://github.com/jyothepro/orqon/issues/386), `bench/factory/tasks/repo-scratch-duration-hours`); no attempt has been made with it yet. See below |
| **M6** — Issue → draft PR | GitHub App intake, issue → acceptance criteria, draft PR out — **the map's destination** ([ADR-0009](../docs/adr/0009-github-app-scope-for-milestone-6.md), [ADR-0012](../docs/adr/0012-m6-task-understanding-extract-first-generate-fallback.md), [ADR-0018](../docs/adr/0018-repository-is-an-entity-resolved-per-task.md), [ADR-0019](../docs/adr/0019-run-branches-carry-the-issue-and-the-run.md)) | ✅ **Done** — two labelled issues produced real draft pull requests on github.com ([#90](https://github.com/jyothepro/content-machine/pull/90), [#92](https://github.com/jyothepro/content-machine/pull/92)), each with a check run and a sticky evidence comment. `pull_request.merged → COMPLETED` is still unobserved |

**The map's destination is reached in reality, not only in code** (2026-09-22). A labelled issue
on github.com produced a verified draft pull request: run `b409263b`, content-machine#91 → draft
PR #92, $0.0997, 10m36s. The wayfinder map [#50](https://github.com/jyothepro/orqon/issues/50) was
closed on 2026-09-19 with a note on what the first run did and did not prove.

A merge driving a run to `COMPLETED` is still only proven in code — see "What M6 actually landed"
below for what
that does and does not prove.

Every milestone-gating decision through M6 is made — no milestone below is decision-blocked.
Model policy for M3–M6 wiring is decided ([ADR-0010](../docs/adr/0010-maker-checker-model-policy-pre-byok.md)).

## What M1 and M2 actually landed

**M1 — factory domain model** (`src/factory/`): the ADR-0003 schema and migration runner
(`migrations/0001_factory_schema.sql`, `migrate.ts`), the run state machine reducer
(`run-state-machine.ts`), entity repositories (`repositories.ts`), the run service
(`run-service.ts`), the ADR-0013 cost ledger (`cost-ledger.ts`) and metrics views, the
ADR-0011 safety rails wired into the run service (`rails.ts`, `rails-gate.ts`), the ADR-0008
evidence-ref writer plus the ADR-0015 retention sweep (`evidence-storage.ts`,
`evidence-retention.ts`), and the ADR-0016 hermetic local dev stack (`docker-compose.yml` +
MinIO). CI runs against a real Postgres service.

**M2 — sandbox abstraction** (`src/sandbox/`): the `SandboxProvider`/`SandboxHandle` seam
(`provider.ts`) with a local-git-backed `FakeSandboxProvider` (`fake.ts`), the Vercel-backed
provider with exec and full `ExecutionEnvironment` file-I/O parity (`vercel.ts`), ADR-0014 §1
credential brokering so no model key ever enters a sandbox (`credential-broker.ts`), ADR-0014
§3 phased egress (`network-phase.ts`) enforced through `runInExecutionPhase` with the ADR-0014
§2 interim verifier push guard (`lifecycle.ts`), and workspace provision/teardown wired to the
cost ledger (`src/factory/workspace-service.ts`).

## Beyond the map (M6 has shipped; this is the remaining route)

| Milestone | Delivers | Notes |
|---|---|---|
| **M7** — Product UI, REST API and CLI | The API with SSE ([ADR-0023](../docs/adr/0023-control-plane-api-reads-direct-writes-intents-updates-resume-from-a-cursor.md)), the CLI and MCP server, the console, and organizations, users and scoped tokens ([ADR-0024](../docs/adr/0024-tenancy-is-account-organization-principal-and-supabase-auth-only-signs-people-in.md)) | ✅ **Done** — API, CLI and MCP (#278, #280), steering and repository secrets (#281), the console (#282), orgs/users/tokens (#283), and the operator commands on the API (ADR-0023 §10, 2026-09-25): `metrics`, `reap`, `capture` and `submit` in the published CLI, `windkeel-admin` down to `doctor` and `secrets keygen`. Porting `task create` found that API-created runs had never been enqueued; fixed in the same change. Console command search (⌘K) shipped with it |
| **M8** — Automations + integrations | Schedules, cron tasks, Slack, Linear, Jira, API/webhook intake | Each intake is M6's shape reused. Ordered here because the loop it feeds is proven and the UI to watch it exists |
| **M9** — BYOK / model routing | OpenRouter and OpenAI-compatible endpoints, sealed organization model keys, layered model policy frozen per run, cost by key source ([ADR-0026](../docs/adr/0026-byok-org-sealed-model-credentials-and-a-per-run-model-snapshot.md)) | ⚠️ **Code complete, not proven live** — #328–#334, and the end-to-end proof [#326](https://github.com/jyothepro/orqon/issues/326) (`test/e2e-m9-byok.test.js`) against fakes at the edges. **No run has called a real model on an organization's key**: the live spike [#318](https://github.com/jyothepro/orqon/issues/318) is not done, so Codex's `-c model_providers…` syntax is unconfirmed against the pinned binary and ADR-0026 is still *Proposed*. AI SDK deliberately not adopted (ADR-0026 §8). See [What M9 actually landed](#what-m9-actually-landed) |
| **Batches** (#391, unsequenced) — Parallel and batch work | One ask fanned out into many independently verified runs: `fanout` (sub-tasks of one change on one repository) and `multi_repo` (the same change across repositories), a per-batch `maxConcurrency` and an organization `max_concurrent_runs`, a required batch spend cap and a failure-ratio breaker; `/v1/batches`, `windkeel batch`, console list and detail ([ADR-0036](../docs/adr/0036-batches-group-verified-runs-and-never-gate-them.md), *Proposed*; [docs/batches.md](../docs/batches.md)) | ⚠️ **Code complete, not proven live** — `test/e2e-batch-loop.test.js` drives a 3-repository batch through the real workflow against fakes at the edges. No live batch has run concurrent Vercel sandboxes. Model-proposed fanout splits (#391 sub-task D) not built |
| **M10** — Planner / risk engine | Criteria generation, risk classification, implementation + verification plans, worker/model selection inputs | Where `risk_level` stops being operator-set and the report stops saying *not scored*. Owns the unsatisfiable-criterion failure mode [#273](https://github.com/jyothepro/orqon/issues/273) found |
| **M11** — Second worker + routing | Second `WorkerAdapter`, capability metadata, routing + fallback, comparative telemetry | Claude Code, then OpenCode ([ADR-0027](../docs/adr/0027-the-maker-harness-is-chosen-with-the-maker-model-and-frozen-per-run.md) §6, amending ADR-0006 §5; OpenHands not scheduled). In progress (#395): harness selection (`model_policy.harness`, snapshot `maker.harness`, `StageDeps.workers`), the shared launcher and conformance suite, and a Claude Code adapter behind `WINDKEEL_MAKER_HARNESSES` — offline-tested only; live proof, console picker and OpenCode pending. Proves `WorkerAdapter` hides worker topology |
| **M12** — Repository / organization memory | Repo knowledge ingestion, policy extraction, learned preferences, reviewer feedback | |
| **M13** — Agent performance intelligence | Run history → model routing, cost optimization, risk prediction, escalation | Most columns are already written per run (ADR-0013); two views over them had to be fixed for flattering the system (#145, #181) |
| **M14** — Enterprise / self-hosted | Self-hosted control plane, customer VPC sandboxes, private endpoints and storage, SSO/RBAC, audit logs, retention | Ships what v1 already is, hardened — single-tenant stays a supported shape (ADR-0001) |
| **M15** — Cloudflare sandbox provider | Second provider plus a benchmark suite: latency, reliability, cost, provider routing | Last because it buys no new capability. Do not switch defaults until measured evidence supports it |
| **Integrated assistant** (unnumbered until sequenced) | Session view (conversation beside workspace tabs), agent/model/mode pickers in the composer, a read-only view of the maker workspace, take-over into a human workspace seeded through git with hand-back and submit, and merge as the signed-in person ([ADR-0029](../docs/adr/0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md), Proposed) | Arises from the Devin UX audit (2026-10-17). Phased in [docs/roadmap-integrated-assistant.md](../docs/roadmap-integrated-assistant.md). Phases 1–3 are console-first and can start now; the model picker leans on M9 (code complete, not proven live) and the agent picker on ADR-0027 (Accepted 2026-10-24); take-over and merge each wait on a spike and the security audit. The verifier stays the gate for every candidate, the person's included |

### The 2026-09-23 reordering

M7–M15 were renumbered on 2026-09-23, after M6 shipped. The deliverables are unchanged; only the
sequence is. A usable surface and the intakes that feed it come before the intelligence layered on
top, and the second sandbox provider — the only remaining milestone that buys no new capability —
goes last.

| Was | Is | Milestone |
|---|---|---|
| M7 | **M10** | Planner / risk engine |
| M8 | **M9** | BYOK / model routing |
| M9 | **M7** | Product UI — now explicitly Product UI, REST API **and** CLI |
| M10 | **M11** | Second worker + routing |
| M11 | **M15** | Cloudflare sandbox provider |
| M12 | **M8** | Automations + integrations |
| M13 | **M12** | Repository / organization memory |
| M14 | **M13** | Agent performance intelligence |
| M15 | **M14** | Enterprise / self-hosted |

**Everything written before 2026-09-23 uses the old numbers** — nine ADRs, `PLAN.md`'s body, and
source comments. Those references were changed to name the milestone rather than number it
(*"the Product UI milestone"*, *"the planner milestone"*), because the names did not move and a
number in a decision record that renumbers later is a trap. The table above decodes any number
that survives in git history. Only one number is rendered to a human at runtime — the run report's
`not scored (Milestone 10)` — and it is now M10.

**Maker browser use (#392, ADR-0035, unnumbered).** The maker gets a headless browser
(`windkeel-browse`) while it builds, for repositories with `flows` or `makerBrowser`; its screenshots
are shown on the run page and in a separate, unverified PR comment, and never reach the candidate,
the evidence package or the verdict. Code-complete with fakes; a live run against a Vercel sandbox
(Chromium actually installed and a localhost screenshot harvested) is still to be proven.

## What M9 actually landed

M9's goal is *make Windkeel model-neutral*: an organization runs the factory on its own model keys and
its own model choices, maker/checker independence stays enforced, and every dollar is attributed to
whose key paid. The decision is [ADR-0026](../docs/adr/0026-byok-org-sealed-model-credentials-and-a-per-run-model-snapshot.md);
its `## As built` section lists each PR and the deviations accepted.

- **#328 (M9-1)** — the model catalog: providers, vendor derived from the model rather than the
  router, per-model prices, `checkIndependence`.
- **#329 (M9-2)** — organization model credentials: sealed box v2 (organization and id bound into the
  AEAD data, `keypair_id` recorded, previous-key rotation), the `base_url` guard, the API, the CLI,
  and a credential check that runs as its own one-step workflow.
- **#330 (M9-3)** — layered policy (organization → repository → task) resolved once at intake into
  `engineering_run.model_config`; independence checked there; the `model_policy` stop reason.
- **#331 (M9-4)** — the checker on the snapshot and on a customer key, through a guarded transport.
- **#332 (M9-5)** — the maker on the snapshot: Codex told `--model` and the provider overrides, the
  broker rule carrying a resolver instead of an environment variable's name.
- **#334 (M9-6)** — cost priced per model from the catalog and attributed by key source; unpriced is
  null, and counted against the spend cap at a conservative rate.
- **#333 (M9-7)** — the console's Models settings and run panel, a `doctor` check, and a sweep that
  re-starts credential checks that never ran.

### What is proven, and what is not

**Proven, in CI, against fakes at the edges** (`test/e2e-m9-byok.test.js`, #326): credentials and
policy set through the real API router → a task through `POST /v1/tasks` → intake freezes the
snapshot with derived vendors → the real Codex adapter, over a stub `codex` binary in a
`FakeSandboxProvider` sandbox, is launched with `--model openai/gpt-5-codex` and the
`model_providers.windkeel` override, the sandbox env holds only the placeholder, and the broker rule for
`openrouter.ai` resolves to the organization's key → review and mapping call a scripted OpenRouter on
loopback through the guarded transport, on the organization's checker key → every model cost event
is `customer`, per credential, priced from the catalog → a verified draft pull request (on
`FakeGitHubClient`), on the real Workflow runtime and real Postgres. Neither key appears in any row,
sandbox call, Codex's argv, or the Workflow journal. A dependent pairing (two OpenAI models, one
through OpenRouter) fails at intake before any sandbox exists; a credential revoked through the API
after provisioning fails the run by name, with no fallback and nothing spent on Windkeel's key.

**Not proven:**

- **No real model has been called on an organization's key.** The live spike
  [#318](https://github.com/jyothepro/orqon/issues/318) — Codex on OpenRouter with a brokered key, in
  a real Vercel sandbox — has not run. Until it has, ADR-0026 stays *Proposed*.
- **The Codex override syntax is unconfirmed against the pinned binary.** `-c
  'model_providers.windkeel={ … wire_api = "responses" }'` follows Codex's documented `-c key=<TOML>`
  form; nothing has run it on the pinned version, and `wire_api = "responses"` against OpenRouter is
  an assumption.
- **The broker's resolver has never fed a real egress proxy.** The tests check that the rule targets
  the provider's host and resolves to the opened value; a fake sandbox has no proxy to attach it.
- **Passing `--model` changes existing deployments.** Codex used to run on its own default whatever
  `WINDKEEL_MAKER_MODEL` said; the first live runs after M9 should confirm the configured model is the
  one that was being used.
- **Prices are list prices** (verified 2026-10-06): no long-context surcharges, no Anthropic
  cache-write premium, and OpenRouter's own margin is not modelled.
- **The private key shares the deployment with the API routes** (since #213). The box separates the
  database and the code path from a key, not code execution inside the deployment; M14's KMS is the
  real reduction. Stated in ADR-0026's Consequences.

## Read of the board

Three milestones shipped (M0, M1, M2). Windkeel can now create a sandbox, clone a repo, run
commands in it under a phased egress policy with a brokered model key, and destroy it with
its cost recorded — M2's success criterion.

M3 is code complete: the factory can drive Codex inside the maker sandbox. Its six tickets
([#109](https://github.com/jyothepro/orqon/issues/109)–[#114](https://github.com/jyothepro/orqon/issues/114))
followed M2's decomposition — a types-and-fake seam first, then pure normalization logic, then
the process-driving implementation — so the whole milestone is tested without a live Codex CLI
or an OpenAI key: `src/worker/adapter.ts` (seam) and `fake.ts`, `src/worker/codex/events.ts`
(JSONL normalizer), `src/worker/command-classification.ts` (test-command shim),
`src/worker/codex/adapter.ts` (start/events/cancel/send) and `result.ts` (diff extraction).

That last property is also the caveat: **M3's success criterion — "prompt → sandbox → worker →
modified repo" — rests on hand-authored fixtures and a stub CLI until someone drives a real
`codex exec` process against a real Vercel sandbox.** The adapter has never done that. Until it
has, treat M3 as code complete rather than done.

M4 is code complete: **a local/API-created task produces a verified code change.** Its seven
tickets ([#125](https://github.com/jyothepro/orqon/issues/125)–[#131](https://github.com/jyothepro/orqon/issues/131))
followed the same decomposition M2 and M3 used — restructuring first, then a types-and-fake seam,
then the durable implementation, then the stages on top:

- **#125** — npm workspaces and `packages/verification`, recovering the engine's
  zero-runtime-dependency property (ADR-0005). A test enforces it now, rather than vigilance.
- **#126/#127** — `WorkflowProvider` + `FakeWorkflowProvider`, then `PgBossWorkflowProvider`
  (ADR-0007). One shared conformance suite runs against both backings. Node moved to 22.12+
  across the repo and CI, because pg-boss 12 requires it and Node 20 is past end-of-life.
- **#128/#129** — the PROVISIONING and IMPLEMENTING stages, and candidate capture: a working
  branch pushed to the remote so a *fresh* verifier sandbox can fetch it without the maker
  (ADR-0004).
- **#130** — the VERIFYING stage: the M0 kernel run in an independent sandbox at the candidate
  SHA, the package sealed, stored, and recorded.
- **#131** — `apps/worker` (ADR-0002 §2), `windkeel task create`, and the end-to-end proof.

### The honesty caveat, the same shape M3 carries

The end-to-end test (`test/e2e-factory-loop.test.js`) drives the **real** `PgBossWorkflowProvider`
against **real Postgres**, so durability, resume-after-kill, exactly-once side effects, the
ADR-0011 rails, and evidence sealing are genuinely exercised. But **the sandbox is
`FakeSandboxProvider` and the worker is `FakeWorkerAdapter`.** So M4 proves the *orchestration*.
It does not prove a real Vercel sandbox or a real `codex exec` — that is still
[#116](https://github.com/jyothepro/orqon/issues/116)'s business, and it is now the single
outstanding thing standing between "code complete" and "done" for both M3 and M4.

Two limitations found while building M4, recorded rather than filed away:

- **A `SandboxHandle` cannot be re-attached from a different process.** `SandboxProvider` has
  `create()` and no `attach()`, so a container that dies holding a sandbox leaves one running
  that nobody can reach; `Workspace.expires_at` is the backstop and an interrupted run fails
  visibly rather than silently paying for a second sandbox. Adding `attach()` is an M2 interface
  question with a real open problem behind it.
- **ADR-0014 §3's execution-phase allowlist needed the git host**, discovered by #129 exactly as
  that ticket predicted. It is now a per-command extension rather than a permanent static entry.

M4's fail path parks at `BLOCKED` with the `RepairPacket` already persisted — `VERIFYING →
REPAIRING` is M5's, and `FAILED` would have closed the very runs M5 exists to continue.

To operate it, see [docs/running-the-factory.md](../docs/running-the-factory.md).

## What the live runs proved, and what they did not (2026-09-22)

Five live runs between 2026-09-19 and 2026-09-22 replaced the fakes with a real GitHub App, real
Vercel sandboxes, a real `codex exec`, real Supabase Postgres and real scanners. **22 runs and
$1.91 across the project's entire live history.**

> Restated 2026-09-22. These figures were recorded as **$10.35** until
> [#263](https://github.com/jyothepro/orqon/issues/263): cached input tokens were billed at the
> full uncached rate, and 94.3% of every input token this system has sent was served from cache.
> The token counts below are unchanged and were always right; the dollars are the vendor's actual
> rates applied to them. Where a figure is load-bearing elsewhere in this document it has been
> restated too, and says so.

| run | outcome | cost | elapsed |
|---|---|---|---|
| `2329bb84` | warn, draft PR [#90](https://github.com/jyothepro/content-machine/pull/90) | $0.0691 | ~8m |
| `f420f448` | FAILED — no OpenAI credit | $0.0003 | 1m07 |
| `f28748b2` | fail ×4, no PR | $0.6891 | 36m35 |
| `6d7151f5` | fail, no PR | $0.2381 | 12m35 |
| `b409263b` | **warn, draft PR [#92](https://github.com/jyothepro/content-machine/pull/92)** | $0.0997 | 10m36 |

**Proven.** Sandbox lifetime and teardown — four verifications of 6+ minutes with no truncation
where the old ceiling was five, and every workspace destroyed by the reaper rather than by the
accident of a short lifetime. ADR-0012 §1's extract-first path, every run. ADR-0017's session
surviving four verifications. ADR-0011's repair cap holding exactly, and its **stuck detection**
firing correctly on a repairer that honestly changed nothing. ADR-0009's PR surface: draft PR,
`Resolves #91`, a check run and a sticky evidence comment. ADR-0010's vendor independence, with
`windkeel doctor` asserting the maker's and checker's vendors differ.

**Not proven, and this is the section that matters.**

**M5 has never converged.** The repair loop has taken six turns across four runs. Three
(`f28748b2`) produced distinct candidates and all three failed re-verification. One (`6d7151f5`)
correctly produced nothing and the run stopped as `stuck`. Two more, on 2026-09-19, completed with
`emptyChange: true`. **Not one has turned a `fail` into a `pass` in production.** Everything around
the loop works — the packet is built, the session resumes, the rails stop it — and the property
the milestone claims has not been observed.

That is not a code defect anyone has identified. It is that every live failure so far has been a
verifier defect ([#227](https://github.com/jyothepro/orqon/issues/227),
[#241](https://github.com/jyothepro/orqon/issues/241),
[#246](https://github.com/jyothepro/orqon/issues/246)) rather than a code defect, and a repairer
cannot fix a verdict that was wrong about the code. M5 will be demonstrated by the first run whose
change is *genuinely* broken and gets fixed. Until then: **observed, not demonstrated.**

**Restated 2026-09-23, after the run [#252](https://github.com/jyothepro/orqon/issues/252) asked
for.** Run `db2bdce9` was that run — a substantive task with a real trap, taken deliberately down
the criteria-generation path. It reached `MAX_REPAIR_ATTEMPTS_REACHED` (`stuck`) at $0.2931 with
7/8 criteria, and **the change was correct.** Checked independently off the machine, from the
captured workspace diff: the clean repository is 385 tests / 376 pass / 9 fail, the same tree with
the candidate applied is 391 / 382 / **the same 9** — all `restic` tests failing for want of
`restic`, identical either way. Every pre-existing test in `src/queue/slots.test.ts` passes and the
diff removes zero lines from it.

The criterion reported unsatisfied was *"all seven pre-existing tests in
`src/queue/slots.test.ts` pass unchanged"*. **The file holds eight tests.** The number came from
the issue's own prose and the issue was wrong; criteria generation copied it faithfully.

The mapper's recorded reason, read back out of the retained package, shows the verifier was not the
thing at fault:

> The stated count of seven is contradicted by the diff itself, **even though these tests are
> unchanged and pass.**

It judged accurately, cited the right evidence item, said out loud that the tests pass — and marked
the criterion `unsatisfied`, which is a `fail`. On the same run AC8 (*"npm test passes"*) was
`satisfied`, citing the suite exiting 0.

**No change to the candidate could ever have satisfied that criterion**: a repairer cannot make
eight tests be seven. So the repair loop was asked to close an *unsatisfiable* criterion, spent one
turn, produced the same candidate SHA, and stuck detection stopped it. The empty change was the
only honest answer available — which is also reason to re-read the two earlier runs recorded as
`emptyChange: true`.

**So the blocker on M5 is neither "no genuinely broken change has come along" nor a verifier that
cannot judge.** It is that `unsatisfied` currently means two different things — *the change does
not do this*, which a repairer can fix, and *this criterion is untrue about the repository*, which
nothing can — and the second fails correct changes and buys repair turns with a known-zero
outcome. [#273](https://github.com/jyothepro/orqon/issues/273) separates them.

**The human-in-the-loop half is now observed** (2026-09-23,
[#253](https://github.com/jyothepro/orqon/issues/253)). All four control surfaces ran in
production:

| Surface | Run | What happened |
|---|---|---|
| Criteria generation → `WAITING_FOR_APPROVAL` | `db2bdce9` | 8 criteria generated by `anthropic/claude-sonnet-5`, independent of the `openai` maker; parked at **$0.0000**, no agent run, no workspace — ADR-0012 §4 holds |
| `/windkeel approve` | `db2bdce9` | released in under a minute; `criteria_provenance = generated`, approver recorded |
| `/windkeel cancel` | `d9ff6108` | `IMPLEMENTING → CANCELLED` in 8 s at $0.0000, and `windkeel reap --dry-run` reports **nothing to reap** — the latch let the stage wind down rather than orphaning a sandbox |
| `pull_request.merged → COMPLETED` | `e81108b4` | draft PR content-machine#95 merged; the run reached **`COMPLETED` in 7 s** |

That last one closes the loop the wayfinder map was drawn for: issue → criteria → approval →
sandbox → verification → verified draft PR → merged → run complete. `merge_rate` and
`human_rework_rate` now read from real rows rather than from an empty column.

Three things were confirmed live in passing, having only ever been tested: `windkeel run capture`
pulled a real 51 KB `codex exec` transcript out of a running maker sandbox (which is also what
[#116](https://github.com/jyothepro/orqon/issues/116) wanted), the approval comment stated its own
72-hour deadline ([#262](https://github.com/jyothepro/orqon/issues/262)), and the report named the
evidence package as unsigned by policy ([ADR-0022](../docs/adr/0022-evidence-package-signing-stays-best-effort-and-says-so.md)).

**Still unobserved.** ADR-0011's spend and wall-clock rails, which have never tripped — the most
expensive run on record is $0.2931 against a $25 cap. Deliberately skipped rather than forgotten:
of the five surfaces, the rails are the one whose failure mode is *over*-caution rather than a
stuck run.

**What the runs cost to learn.** Three verifier defects, each hidden by the one before it, plus a
codex version pin six minor versions stale
([#244](https://github.com/jyothepro/orqon/issues/244)) and two cost-accounting defects
([#242](https://github.com/jyothepro/orqon/issues/242),
[#243](https://github.com/jyothepro/orqon/issues/243)). The same task went from **four turns and
nothing** to **one turn and a draft pull request** over three attempts — $0.69 to $0.10 at the
restated rates above.

## What M6 actually landed

M6 is code complete: **a GitHub issue drives the factory, and a verified draft pull request comes
out.** Ten tickets ([#154](https://github.com/jyothepro/orqon/issues/154)–[#163](https://github.com/jyothepro/orqon/issues/163)),
in dependency order:

- **#154/#155** — the GitHub seam and the real client. `GitHubClient` expresses ADR-0009's scope
  and refuses the rest: `createPullRequest` takes no `draft` flag because the App only opens
  drafts, and there is no merge, approve, or ready-for-review method because those are not
  capabilities this system has. The real client is `fetch` + `node:crypto` — no Octokit, no new
  dependency — and passes the same conformance suite as the fake, driven by a stub that speaks
  GitHub's wire shapes rather than by the fake wearing an HTTP veneer.
- **#156** — the `Repository` entity ([ADR-0018](../docs/adr/0018-repository-is-an-entity-resolved-per-task.md)).
  `engineering_task.repository_id` had been a uuid with no table behind it since M1, and which
  repository a run worked against came from container configuration. It is now per task, with the
  local path as the only fallback and a loud refusal for anything else — a task from outside that
  cannot find its repository is a bug, not a default.
- **#157** — `apps/ingress`, the Vercel half. Signature before parse, parse before database; the
  delivery record commits in the same transaction as the work it causes, because recording it
  first turns any transient failure into a permanently dropped event GitHub's retry can no longer
  fix. Every ignored event answers with a *reason*, which is usually the fastest explanation of
  "I added the label and nothing happened".
- **#158** — the label trigger. Extraction is verbatim and model-free; the zero-criteria case is
  *routed*, not resolved, because a model call on the ingress is what ADR-0002 §3 forbids.
  Re-labelling a task whose runs are all terminal starts a fresh run with criteria re-read from
  the issue as it is now.
- **#159** — the approval gate. The three M4 placeholder intake stages are replaced by four real
  ones, with no change to the run state machine. `assertProvisionable` runs *in* PROVISIONING, so
  a run holding unapproved machine-written criteria fails rather than getting a sandbox — the
  money is what the pause exists to protect. Approval is auditable from rows alone.
- **#160** — ADR-0014 §2 closed for real. Per-workspace, per-role installation tokens: the maker
  gets `contents: write`, the verifier `contents: read`, so **the verifier is unable to push
  rather than forbidden to**. The fake sandbox learned to express that — a read-only credential
  gets a read-only remote — so the property is proved by a push through `sh -c` failing at the
  far end, not by the static guard that cannot see through a shell string.
- **#161** — the reviewer's surface, as pure rendering, with golden files. It reports what the
  rows know and points at the evidence package for per-stage results rather than inferring them,
  because a stage that did not run must never read as a pass (#35). Residual risk says "not
  scored": PLAN §16 shows a level and no field backs it before the planner milestone (M10).
- **#162** — `PR_CREATING`, `PR_READY`, `WAITING_FOR_HUMAN`. ADR-0003's happy path completes for
  the first time in the project's history. Every external mutation is find-first, so a redelivery
  adopts the pull request instead of opening a second one.
  [ADR-0019](../docs/adr/0019-run-branches-carry-the-issue-and-the-run.md) resolves the branch
  convention ADR-0009 §5 and M4.5 disagreed about — the name carries the issue *and* the run,
  because a name from the issue alone is not unique across the fresh runs ADR-0009 §3 allows.
- **#163** — the end-to-end proof, plus [docs/github-app.md](../docs/github-app.md): registering,
  installing, and triggering, complete enough to go from zero to a draft PR without reading source.

### The honesty caveat, now with three layers

`test/e2e-github-loop.test.js` drives a **signed webhook delivery** through the **real ingress
handler**, the **real `PgBossWorkflowProvider`** against **real Postgres**, and the real stage
handlers. Both verdicts come from the engine observing the repository: the fixture's own
`npm test` fails on the defect and passes after the repair, with the review and mapping models
held constant across both cycles so they cannot be what flips the verdict.

But **the sandbox is `FakeSandboxProvider`, the worker is `ScriptedWorkerAdapter`, and the GitHub
side is `FakeGitHubClient` with locally-signed payloads.** So M6 proves the *orchestration*: a
signed delivery becomes a task, a run, a defect, a repair, a second verification, one draft pull
request, one check run, one sticky comment, and a `COMPLETED` run — all durable, all reconstructible
from rows. It does not prove a real Vercel sandbox, a real `codex exec`, or a real GitHub App
installation talking to github.com. M3, M4, M5, and now M6 are all "code complete" rather than
"done" for the same reason, and it remains
[#116](https://github.com/jyothepro/orqon/issues/116)'s to close.

Two further things worth naming rather than burying:

- **The `engineering_task.repository_id` foreign key has landed, validated** (#181's sibling,
  `migrations/0010`). `migrations/0005` deferred it because pre-M6 tasks carry uuids the local CLI
  invented, and named the exit condition: once no such task remains. The condition turned out to
  be met by absence rather than by cleanup — Windkeel has never been deployed, so no database with
  pre-0005 history exists to hold one. 0010 checks for orphans before constraining and refuses by
  name, with a count and the query, rather than leaving a raw constraint violation for whoever
  runs it against a database that does have history. `resolveRepositoryTarget` keeps enforcing
  the same invariant in code; the constraint is a second line of defence, not a replacement.
- **`human_commits_after_pr` is now measured, or recorded as unknown** (#181). It went unwritten
  through M6 for a good reason — the `pull_request.closed` payload carries a PR commit count, not
  "commits a human added after Windkeel opened it" — but the column was `not null default 0`, so the
  absence read as a measured zero and the two views over it reported 0% rework and a 100%
  clean-merge rate from no data. It is now computed from the pull request's commit list when the
  PR merges, and is `null` when it cannot be computed honestly; the views exclude a null run
  instead of counting it clean. See the ADR-0013 amendment.

## What M5 actually landed

M5 is code complete: **worker creates a defect → Windkeel catches it → worker repairs it → Windkeel
passes it.** Six tickets ([#141](https://github.com/jyothepro/orqon/issues/141)–[#146](https://github.com/jyothepro/orqon/issues/146)),
in dependency order, each one unblocking the next:

- **#141** — the lifetime question M4 left unanswered. `teardownAll` destroyed every workspace at
  a fail verdict, so ADR-0011 §2's "the session is resumed" was unreachable: both the maker
  sandbox and the in-process handle addressing its session were gone before a repair could start.
  [ADR-0017](../docs/adr/0017-the-maker-outlives-verification-while-the-repair-loop-has-budget.md)
  decides it — the maker is held across VERIFYING while the loop has budget — and
  `handlers/loop-exit.ts` makes teardown a property of the control flow rather than of nine
  remembered call sites. Idle sandbox time now reaches the cost ledger *while* the loop runs, so
  the spend cap can see it.
- **#142** — the REPAIRING handler. The packet is sent verbatim on the resumed session, cost is
  charged per turn (never the cumulative session total), and every refusal — an adapter that
  cannot resume, a session this process cannot reach, a `send()` that throws — is a named run
  outcome rather than a crash or a cold start dressed up as a resume.
- **#143** — the cycle closes: the repairer's work becomes a new candidate on the same run
  branch, fast-forward only, with its own verification and its own evidence package. A repair
  turn that changes nothing terminates the run as `stuck` instead of spinning, and ADR-0015's
  superseded-package tier is exercised against real data for the first time.
- **#144** — ADR-0011's rails proved against a loop that actually loops. The tier caps (3/2/1)
  are counted from repair turns a real loop took rather than from `checkRepairLoop`'s agreement
  with itself, and the cap boundary is now written down where it cannot drift from the code.
- **#145** — the run report: a run's whole story answerable from the database alone, rendered as
  PLAN §16's block, printable with `windkeel run report <run-id>`. Two metrics views written for a
  factory whose loop had never run were fixed; both had flattered the system.
- **#146** — the end-to-end proof on the real durable stack.

### The honesty caveat, carried forward unchanged

`test/e2e-repair-loop.test.js` drives the **real** `PgBossWorkflowProvider` against **real
Postgres** (and real MinIO when `S3_ENDPOINT` is set). Both verdicts come from the engine
observing the repository — the fixture repo's own `npm test` fails on the defect and passes after
the repair, and the review and mapping models are held constant across both cycles so they cannot
be what flips the verdict.

But **the sandbox is `FakeSandboxProvider` and the worker is `ScriptedWorkerAdapter`** — canned
edits applied in a scripted order, not a coding agent, in a local temp clone, not an isolated
microVM. So M5 proves the *orchestration* of the repair loop. It does not prove that a real
`codex exec resume` continues a real session inside a real Vercel sandbox, which is the one thing
that would move M3, M4, and M5 from "code complete" to "done", and remains
[#116](https://github.com/jyothepro/orqon/issues/116)'s.

One consequence of ADR-0017 worth naming rather than burying: **a worker container that restarts
between VERIFYING and REPAIRING ends the run at `FAILED` with `stop_reason = "error"`.** The run
row resumes exactly as ADR-0007 promises; the live sandbox and the live worker session do not,
because neither interface has an `attach()`. That is a real reduction in resilience against
process death, taken deliberately in exchange for not silently shipping a weaker loop under the
name of ADR-0011 §2's resumed turn.

All four operational decision tickets are resolved (#78 evidence retention → ADR-0015, #79
sandbox secrets → ADR-0014, #80 observability/cost → ADR-0013, #81 local dev → ADR-0016).

Remaining open work outside the milestone tickets: [#49 — run the OSS replay evaluation with
a real reviewer credential](https://github.com/jyothepro/orqon/issues/49) (a human task that
validates the M0 verifier against real PRs) and the
[wayfinder map #50](https://github.com/jyothepro/orqon/issues/50) itself.
