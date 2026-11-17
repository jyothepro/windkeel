# ADR-0036: Batches group and pace independently verified runs, and never gate them

- Status: Accepted
- Date: 2026-10-21

## Context

Competitors sell throughput: one ask becomes many agents at once (parallel sessions; one change fanned out across repositories for a migration), with a roll-up view.

## Decision

**A batch is grouping, scheduling and a roll-up — nothing else. Every child is an ordinary engineering task with its own run, rails, independent verification, evidence and draft pull request. Nothing a batch holds can make a child pass, fail, become ready or merge.**

- §1 — Two kinds: `fanout` — one ask split into caller-supplied sub-tasks on one repository; `multi_repo` — the same title, description and criteria applied to a list of repositories, one task per repository (ADR-0018: a task has one repository).
- §2 — Children are materialised lazily, through the one intake path: A `batch_item` is a row, not a run, until a slot is free.
- §3 — Two concurrency limits: A batch's `max_concurrency` (1–50, default 3) and the organization's `max_concurrent_runs` (default 10, `WINDKEEL_DEFAULT_ORG_MAX_CONCURRENT_RUNS` when the organization sets none), which counts every run in the organization, batch child or not.
- §4 — The batch spend cap is required by default: as ADR-0011 §4's is: absent means the default ($100), and `null` (no batch cap) only with an explicit `uncappedConfirmed`.
- §5 — A failure-ratio breaker: With `stop_on_failure_ratio` set, once at least three children have settled and failed / settled reaches it, the batch stops the same way (`stop_reason = failure_ratio`).
- §6 — Status is lifecycle; progress is derived: `batch.status` stores `RUNNING`, `PAUSED`, `STOPPING` and the settled outcome (`COMPLETED` when every child succeeded — merged, or a pull request the verifier passed — `FAILED` when none did, `PARTIAL` otherwise, or `CANCELLED`).
- §7 — No gating surface: The API has create, read, pause, resume and cancel.
- §8 — Dispatch is safe under concurrency without a session lock.
- §9 — Authorization: `batches.manage` (Admin) creates and changes batches; `runs.read` reads them.

## Consequences

- Fan-out multiplies verified runs and nothing else.
- Worst-case batch spend is bounded by construction: spent plus the unspent caps of every non-terminal child — working, or awaiting review and resumable by *Make changes* — never exceeds the batch cap, so a capped batch cannot pass its cap through children that were each within theirs.
- The reservation makes a small cap serialise its children (a $20 cap with $25 child caps runs one child at a time), and a batch whose budget is held by children awaiting review waits on its reviewers.
- One process-global source notifier is now always registered on the flow function, so `notifyRunOutcome` reads the task for every notifiable transition (a handful per run), not only on deployments with Slack, Linear or Jira connected.

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-10-21
- Resolves: [#391 — Parallel and batch work](https://github.com/jyothepro/orqon/issues/391)
- Builds on: [ADR-0003](0003-factory-domain-model-and-run-state-machine.md) (unchanged: no new run
  state), [ADR-0004](0004-verification-runs-in-a-fresh-independent-sandbox.md) (unchanged: every
  child is verified on its own), [ADR-0011](0011-repair-loop-policy-and-run-safety-rails.md)
  (its rule, applied to the batch as a whole), [ADR-0012](0012-m6-task-understanding-extract-first-generate-fallback.md)
  (criteria extracted, never supplied pre-approved),
  [ADR-0024](0024-tenancy-is-account-organization-principal-and-supabase-auth-only-signs-people-in.md)
  (one permission, `batches.manage`), [ADR-0029](0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md)
  (the verifier stays the gate)

### Context

Competitors sell throughput: one ask becomes many agents at once (parallel sessions; one change
fanned out across repositories for a migration), with a roll-up view. Windkeel ran one task → one run
→ one pull request.

Windkeel's edge is the independent verifier: every candidate is judged in a fresh sandbox the maker
never touched (ADR-0004), and there is no path around it (ADR-0029). Fan-out that introduced a
"batch merge", an aggregate pass, or any shortcut a batch could take past per-run verification
would trade that edge for speed. And N runs are N× the spend: ADR-0011 bounds one run, so without a
bound of its own "migrate 200 repositories" would be an unbounded spend instrument made of
individually capped parts.

### Decision

**A batch is grouping, scheduling and a roll-up — nothing else. Every child is an ordinary
engineering task with its own run, rails, independent verification, evidence and draft pull
request. Nothing a batch holds can make a child pass, fail, become ready or merge.**

1. **Two kinds.** `fanout` — one ask split into caller-supplied sub-tasks on one repository;
   `multi_repo` — the same title, description and criteria applied to a list of repositories, one
   task per repository (ADR-0018: a task has one repository). Children are independent: no shared
   workspace, no child depending on another's diff. A model-proposed split is out of this decision.
2. **Children are materialised lazily, through the one intake path.** A `batch_item` is a row, not
   a run, until a slot is free. Then the dispatcher creates the task and run through
   `createTaskFromIntake` → `createTaskAndRun` (source `batch`, reference `batch:{id}:{ordinal}`),
   so ADR-0011's rails are applied at creation like any intake's, criteria are extracted from the
   description with `explicit` provenance (ADR-0012 §1; a batch's criteria are rendered into each
   child's description, never written as pre-approved), and the unique (organization, source,
   reference) index admits one task per item however often a dispatch is retried. **No run state is
   added** (ADR-0003 unchanged), and a held item is never a `CREATED` run the stranded-created-runs
   sweep could resurrect.
3. **Two concurrency limits.** A batch's `max_concurrency` (1–50, default 3) and the organization's
   `max_concurrent_runs` (default 10, `WINDKEEL_DEFAULT_ORG_MAX_CONCURRENT_RUNS` when the organization
   sets none), which counts every run in the organization, batch child or not. A child holds a slot
   in every non-terminal state except `WAITING_FOR_HUMAN`: a verified pull request awaiting review
   holds no sandbox, and a batch that waited on every reviewer would never finish. Freeing the
   slot does **not** free the child's budget (§4).
4. **The batch spend cap is required by default**, as ADR-0011 §4's is: absent means the default
   ($100), and `null` (no batch cap) only with an explicit `uncappedConfirmed`. Each child's own
   cap is its template cap (or ADR-0011's $25) **lowered to what is left of the batch's budget** —
   cap minus spent minus what every **non-terminal** child may still spend under its cap — so the
   children that can still spend always fit inside the batch cap together, and `checkCaps`
   enforces each one exactly as it enforces any run. The reservation covers a child in
   `WAITING_FOR_HUMAN` too: *Make changes* takes that same run back through `HUMAN_EDITING` to
   `VERIFYING` or `IMPLEMENTING` (ADR-0029 §3) and it spends again under its own cap, so releasing
   its unspent cap at review would let the batch pass its cap (a $10 batch, an $8 child that spent
   $3 and awaits review: the next child gets $2, not $7). Consequently **a batch whose budget is
   fully held by children awaiting review waits for reviewers** — merging, closing or cancelling
   one releases its reservation — before it starts more children; it neither stops nor settles
   while any child holds a reservation (maintainer decision, 2026-10-21). When the spent total reaches the cap the batch goes `STOPPING`
   with `stop_reason = batch_spend_cap`: **children in flight finish within their own caps and no
   new child starts** (maintainer decision, 2026-10-21). An uncapped batch still caps every child.
5. **A failure-ratio breaker.** With `stop_on_failure_ratio` set, once at least three children
   have settled and failed / settled reaches it, the batch stops the same way
   (`stop_reason = failure_ratio`). "Failed" is the child's own terminal state
   (`FAILED`, `MAX_REPAIR_ATTEMPTS_REACHED`) — read, never decided.
6. **Status is lifecycle; progress is derived.** `batch.status` stores `RUNNING`, `PAUSED`,
   `STOPPING` and the settled outcome (`COMPLETED` when every child succeeded — merged, or a
   pull request the verifier passed — `FAILED` when none did, `PARTIAL` otherwise, or `CANCELLED`).
   Counts by state, verdict counts and cost (the SUM of the children's `engineering_run.cost`) are
   computed on read from the children, never stored. The roll-up writes nothing back to a child.
7. **No gating surface.** The API has create, read, pause, resume and cancel. There is no batch
   approve, merge, mark-ready or aggregate verdict, and the console offers none. Cancel cancels
   each child still working through the ordinary run-cancel path; a child whose verified pull
   request already waits on a reviewer is finished work and is left alone. This is a maintainer
   decision (2026-10-21) that differs from #391's "cancel cancels non-terminal children": cancelling
   stops what is running, it does not throw away what the verifier passed. Such a child keeps its
   reservation (§4), so a later *Make changes* on it still spends within the batch cap.
8. **Dispatch is safe under concurrency without a session lock.** One organization is dispatched
   in one transaction holding a transaction-scoped advisory lock on it and its live batches' rows,
   so the limits are read and spent by one dispatcher at a time — including from the flow
   function, whose pool is the transaction pooler. It runs after a batch is created or resumed,
   after a child settles (a `batch` source notifier, which `advanceRun` already calls after every
   notifiable transition), and on the five-minute `/api/schedules` cron as the safety net.
9. **Authorization.** `batches.manage` (Admin) creates and changes batches; `runs.read` reads them.
   Each child is created by the person who asked for the batch (it is their explicit request, not
   an automation), and each repository's grant is checked again at dispatch: a grant withdrawn
   mid-batch skips that item with its reason.

### Consequences

- Fan-out multiplies verified runs and nothing else. Every pull request a batch produces carries
  its own verification, check run and evidence; a reviewer merges each on its own.
- Worst-case batch spend is bounded by construction: spent plus the unspent caps of every
  non-terminal child — working, or awaiting review and resumable by *Make changes* — never exceeds
  the batch cap, so a capped batch cannot pass its cap through children that were each within
  theirs. The one exception is a person starting a further run on a child task by hand
  (`POST /v1/runs`), which is their own act under ADR-0011's rails; its cost counts toward the
  batch's spent total.
- The reservation makes a small cap serialise its children (a $20 cap with $25 child caps runs one
  child at a time), and a batch whose budget is held by children awaiting review waits on its
  reviewers. That is the price of a hard bound and is visible in the roll-up as `reservedUsd` and
  `remainingBudgetUsd`.
- One process-global source notifier is now always registered on the flow function, so
  `notifyRunOutcome` reads the task for every notifiable transition (a handful per run), not only on
  deployments with Slack, Linear or Jira connected.
- Defaults — `max_concurrency` 3, organization limit 10, batch cap $100, 200 items per batch
  (`WINDKEEL_BATCH_MAX_ITEMS`) — are configuration; the existence and semantics of the limits and the
  rule that a batch never gates are not.
- Left open: model-proposed fanout splits behind an approval (#391 sub-task D), batches created
  from Slack/Linear/Jira, billing roll-ups, and environment snapshots that would make fan-out cheap.
