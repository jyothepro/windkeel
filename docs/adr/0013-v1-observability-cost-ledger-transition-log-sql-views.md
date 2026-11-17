# ADR-0013: v1 observability — a cost ledger, a transition log, PR outcome on the run, and SQL views

- Status: Accepted; amended by ADR-0028 (proposed)
- Date: 2026-08-18

## Context

Plan §20 says "capture every run from day one" and lists twelve metrics, but the Milestone 1 schema locked by ADR-0003 does not support them.

## Decision

**Cost is an append-only ledger with a denormalized running sum; run timing is an append-only transition log; PR outcome is recorded on the run from webhooks; the §20 metrics ship as SQL views behind a CLI command. Nothing leaves Postgres in v1.**

- §1 — Cost: `cost_event` ledger + `EngineeringRun.cost` as a maintained sum.
- §2 — Timing: `run_state_transition` log.
- §3 — PR outcome on the run.
- §4 — Query surface: SQL views + `windkeel metrics`.

## Consequences

- The spend rail becomes correct rather than approximately correct: every billable unit reaches `EngineeringRun.cost`, so a $25 cap means $25 including verification and sandbox time, not just maker tokens.
- All twelve §20 metrics are answerable from Milestone 1 onward, and `cost per verified PR` — the stated COGS metric — is a single join across the ledger, the transition log, and `pr_merged_at`.
- Two append-only tables mean writes on every transition and every billable unit (order tens of rows per run).
- The denormalized `cost` column is the one invariant this ADR introduces that can rot silently.

**Later changes** (full text in Background):

- Amendment (2026-09-07): `human_commits_after_pr` is measured or unknown, never assumed

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-08-18
- Resolves: [#80 — Decide v1 observability and cost capture](https://github.com/jyothepro/orqon/issues/80) (wayfinder map [#50](https://github.com/jyothepro/orqon/issues/50))

### Context

Plan §20 says "capture every run from day one" and lists twelve metrics, but the Milestone 1 schema locked by ADR-0003 does not support them. Auditing the list against the entities:

| §20 metric | Supported today? |
|---|---|
| task success rate, first-pass verification rate, repair success rate | Yes — `EngineeringTask.status`, `VerificationRun.verdict`, `RepairAttempt.result` |
| model tokens, model cost (maker side) | Yes — `AgentRun.token_usage`, `AgentRun.model_cost` |
| verification cost, model tokens (checker side) | **No** — `VerificationRun` has no cost or token fields |
| sandbox duration, sandbox cost | **No** — `Workspace` records `expires_at` and `status`, not lifetime or usage |
| time to PR | **No** — only run-level `started_at`/`completed_at`; no `PR_READY` timestamp, and `BLOCKED`/`WAITING_*` pauses are invisible |
| merge rate, human rework rate | **No** — nothing records the PR's fate or whether a human pushed commits before merge |
| cost per verified PR (COGS) | **No** — it is the aggregate of the four gaps above |

Two of those gaps are correctness problems, not reporting gaps. ADR-0011's spend rail refuses the next stage when accumulated `EngineeringRun.cost` reaches the cap; if verification-side model spend and sandbox spend never reach that column, the rail systematically under-counts and a "capped" run overspends. ADR-0007's consequence — run state is plain SQL, joinable for §20 queries — is what this ADR cashes in.

Available inputs: the Vercel Sandbox SDK returns per-session `activeCpuUsageMs` and `networkTransfer` from `stop()` ([vercel-sandbox findings](../../research/vercel-sandbox/findings.md) §3, §6), so sandbox cost is computable per workspace rather than estimated. ADR-0009 already subscribes to `pull_request` events, so PR outcome arrives without polling. ADR-0001 means one operator: honest numbers are required, an audience for dashboards does not exist yet.

### Decision

**Cost is an append-only ledger with a denormalized running sum; run timing is an append-only transition log; PR outcome is recorded on the run from webhooks; the §20 metrics ship as SQL views behind a CLI command. Nothing leaves Postgres in v1.**

#### 1. Cost: `cost_event` ledger + `EngineeringRun.cost` as a maintained sum

```text
cost_event
  id                  uuid
  engineering_run_id  uuid        -- every cost belongs to exactly one run
  stage_type          agent_run | verification_run | workspace
  stage_id            uuid        -- the row it is attributed to
  kind                model | sandbox
  tokens_in           int null    -- model only
  tokens_out          int null    -- model only
  usd                 numeric
  recorded_at         timestamptz
```

- **One row per completed billable unit**, written when the stage that incurred it completes: each model call's usage (maker `AgentRun`s *and* checker-side calls under a `VerificationRun`), and each `Workspace` teardown (from the sandbox provider's returned usage metrics).
- **`EngineeringRun.cost` is incremented in the same transaction as the insert.** It is a denormalized sum, kept solely so ADR-0011's rail stays a single-column read on the hot path. Drift between the column and `SUM(cost_event.usd)` is a bug; the M1 run service ships a test asserting they agree.
- **Per-stage attribution comes from the join**, so `AgentRun.model_cost`/`token_usage` and any per-entity cost column become derived conveniences, never a second source of truth. New cost sources (a second worker, a different sandbox provider, egress charges) need rows, not migrations.

#### 2. Timing: `run_state_transition` log

```text
run_state_transition
  id                  uuid
  engineering_run_id  uuid
  from_state          text null   -- null on the initial CREATED row
  to_state            text
  reason              text null   -- ADR-0011 stop_reason, or the transition's trigger
  at                  timestamptz
```

Written by the ADR-0007 reducer on **every** legal transition, in the transaction that moves the run. This is the single source for time-to-PR (`CREATED` → `PR_READY`), per-state durations, `BLOCKED`/`WAITING_FOR_APPROVAL`/`WAITING_FOR_HUMAN` pause time, and the repair-cycle timeline. It doubles as the audit trail for ADR-0003's "any transition not in the table is illegal" — a rejected transition is recorded nowhere, so the log is exactly the legal history.

#### 3. PR outcome on the run

`EngineeringRun` gains `pr_number`, `pr_merged_at`, and `human_commits_after_pr`, populated from the `pull_request` events ADR-0009 already subscribes to. Merge rate and human-rework rate — the two metrics closest to §20's key business metric, "verified engineering work merged without human rework" — become first-class recorded facts rather than something reconstructed from a mutable remote later.

#### 4. Query surface: SQL views + `windkeel metrics`

The §20 metric list ships as **named SQL views** in the migrations (ADR-0008's numbered forward-only files), and a `windkeel metrics` CLI command prints them. Versioned with the schema, runnable locally and in CI, no new vendor and no new credential. **No dashboard, no alerting service, and no metrics export in v1** — the ADR-0011 rails already stop runaway runs at the source, and `stop_reason` explains every stop; an alerting pipeline with one operator and no on-call rotation would be ceremony. Adding an external observability surface is a later, separate decision.

#### Amendment to ADR-0003

Recorded explicitly, in the style ADR-0011 established: `EngineeringRun` gains `pr_number`, `pr_merged_at`, `human_commits_after_pr`; two new entities (`cost_event`, `run_state_transition`) join the model as append-only children of `EngineeringRun`. No entity is removed, no state or transition changes, and `EngineeringRun.cost` keeps its meaning — it is now defined as the maintained sum of the run's ledger.

### Consequences

- The spend rail becomes correct rather than approximately correct: every billable unit reaches `EngineeringRun.cost`, so a $25 cap means $25 including verification and sandbox time, not just maker tokens.
- All twelve §20 metrics are answerable from Milestone 1 onward, and `cost per verified PR` — the stated COGS metric — is a single join across the ledger, the transition log, and `pr_merged_at`.
- Two append-only tables mean writes on every transition and every billable unit (order tens of rows per run). At ADR-0001's scale this is free; both tables are natural candidates for retention pruning, which is #78's decision, not this one.
- The denormalized `cost` column is the one invariant this ADR introduces that can rot silently. The mitigation is a test, and the recovery is a recompute from the ledger — which is possible precisely because the ledger, not the column, is the source of truth.
- Metrics live in the same database as run state, so a §20 question is a SQL join rather than a correlation across systems — the payoff ADR-0007 predicted when it made Postgres authoritative.
- Choosing no external observability surface is reversible at any time: the ledger and transition log are exactly the event streams such a surface would consume.

### Amendment (2026-09-07): `human_commits_after_pr` is measured or unknown, never assumed

§3 above says the three PR-outcome fields are "populated from the `pull_request` events ADR-0009 already subscribes to". That is true of `pr_number` and `pr_merged_at`, and it is **not true of `human_commits_after_pr`**. The `pull_request.closed` payload carries the pull request's *total* commit count, which is a different number; writing it into this field would attribute Windkeel's own commits to a human and flatter the metric this ADR exists to keep honest. So M6.9 correctly wrote nothing — and the column, declared `integer not null default 0`, therefore reported a measured zero for every run. `human_rework_rate` answered 0% and `verified_work_merged_without_rework` answered 100%, from no data at all.

Amended in three parts:

1. **The column is nullable with no default.** `null` is *not measured*; `0` is *measured, and a human added nothing*. The two states were previously indistinguishable, and that is the whole defect — an absence that reads as a perfect score is #35's "skipped must never read as passed", in SQL.

2. **It is computed from the pull request's commit list**, once, when the pull request merges. `GitHubClient` gains `listPullRequestCommits`, which sits inside the `pull_requests: read` ADR-0009 §1 already grants and adds no permission. A commit counts as human when it has one parent — a merge commit authors no change, and GitHub's "Update branch" button makes one under the clicking user's name — and its **author** is not `WINDKEEL_GIT_AUTHOR_EMAIL`. Author rather than committer, because a rebase rewrites the committer and preserves the author. Repair commits are excluded by identity rather than by timestamp, which is what makes ADR-0017's "the maker outlives verification" case correct here without any special handling.

3. **It refuses to answer rather than guess.** Past GitHub's 250-commit cap the count is a floor; a commit with no author email cannot be attributed; a failed API call knows nothing; a hermetic run (ADR-0016) has no GitHub client at all. Each records `null` with the reason in the run's transition reason, and both views exclude the run rather than counting it.

The views now report `merged_unmeasured` alongside their rate, so a reader can see how much was set aside. `verified_work_merged_without_rework` narrows its denominator rather than nulling its rate, so one unmeasurable run does not suppress the project's headline metric permanently.

No entity is removed, no state or transition changes, and no other §20 metric is affected.
