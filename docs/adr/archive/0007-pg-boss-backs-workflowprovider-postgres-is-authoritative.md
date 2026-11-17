# ADR-0007: pg-boss backs WorkflowProvider; Postgres run rows are the authoritative state

- Status: Superseded by ADR-0021
- Date: 2026-08-17
- Superseded on 2026-09-19 by [ADR-0021](../0021-vercel-workflow-backs-workflowprovider.md), when #200 deleted the pg-boss provider. Only the *backing* is replaced. Decision §1 — Postgres run rows are authoritative; jobs are transport, never truth — is carried forward unchanged, and it is the claim that made the replacement a wiring change rather than a migration (`test/postgres-authoritative.test.js`).

## Context

Plan §8 defines `WorkflowProvider { startRun, signal, cancel, status }` as the seam between the factory service and whatever makes runs durable.

## Decision

**`WorkflowProvider` v1 is backed by pg-boss embedded in the worker container, and the `EngineeringRun` row in Postgres is the single authoritative run state.**

- §1 — The ADR-0003 transition table is the workflow: The factory service implements the state machine as its own reducer over `EngineeringRun` rows; every legal transition is a checkpoint written to Postgres.
- §2 — `signal` and `cancel` are data: Ingress (the Vercel webhook, ADR-0002) persists a signal row / enqueues a job; the factory picks it up.
- §3 — Long agent sessions are modeled as start-work → handle-completion transitions.
- §4 — What we now own.

## Consequences

- No new vendor, no second state store, no license or pricing exposure: MIT pg-boss plus the Postgres that #61 already had to provide (pg-boss requires Postgres 13+, Node 22.12+).
- Run state is plain SQL — joinable with the rest of the factory schema for the §20 observability queries, and the ADR-0003 transition-table test runs against the same reducer production uses.
- The correctness burden (idempotency, resumable half-finished stages) is ours forever; the mitigations are the transition-table tests and the data-shaped seam.
- Plan §8's "eve / Vercel Workflow can provide durable infrastructure underneath" is superseded for v1: eve is not used; the plan is annotated accordingly.

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Superseded by ADR-0021
- Superseded on 2026-09-19 by [ADR-0021](../0021-vercel-workflow-backs-workflowprovider.md), when #200 deleted the pg-boss provider. Only the *backing* is replaced. Decision §1 — Postgres run rows are authoritative; jobs are transport, never truth — is carried forward unchanged, and it is the claim that made the replacement a wiring change rather than a migration (`test/postgres-authoritative.test.js`).
- Date: 2026-08-17
- Resolves: [#60 — Decide the orchestration backing for WorkflowProvider](https://github.com/jyothepro/orqon/issues/60) (wayfinder map [#50](https://github.com/jyothepro/orqon/issues/50))

### Context

Plan §8 defines `WorkflowProvider { startRun, signal, cancel, status }` as the seam between the factory service and whatever makes runs durable. The [durable-orchestration findings](../../../research/durable-orchestration/findings.md) compared four backings — Vercel Workflow SDK, Inngest, Trigger.dev, and pg-boss with a hand-rolled state machine — and eliminated none a priori, but the decisions since then prune hard:

- ADR-0002: the factory service lives in a long-lived worker container; the backing must run embedded in or be drivable from it. Serverless step caps are irrelevant; the embedded Postgres-native shapes are fully available. Trigger.dev would add a third deploy target beside Vercel and the worker container — against the topology ADR-0002 chose.
- ADR-0003: the run state machine is already locked as an explicit legal-transition table on `EngineeringRun.status`, with "any transition not in the table is illegal, and the factory service must reject it." Windkeel owns a precise state machine no matter what; a replay- or memoization-based engine would keep a second, engine-internal run/step log beside it — two sources of truth for "where is this run."
- The findings' residual concerns about the remaining engine options: Workflow SDK's Postgres World is the youngest backend of a ~10-month-old GA product with compiler-transform magic and the weakest programmatic cancel; Inngest needs Connect (beta) for long steps and keeps engine state outside our Postgres, with an SSPL server if self-hosted and a 5-concurrent-step free tier.
- pg-boss (MIT, mature, `SKIP LOCKED` job delivery) ranked best of the four for local dev and testing: dockerized Postgres, deterministic unit tests over the transition reducer, no dev server or cloud account.

The ticket also requires settling where run-state transitions are authoritative: Postgres rows vs a workflow engine's internal state.

### Decision

**`WorkflowProvider` v1 is backed by pg-boss embedded in the worker container, and the `EngineeringRun` row in Postgres is the single authoritative run state.**

Concretely:

1. **The ADR-0003 transition table is the workflow.** The factory service implements the state machine as its own reducer over `EngineeringRun` rows; every legal transition is a checkpoint written to Postgres. pg-boss jobs drive transitions (pick up a run, do the stage's work, commit the next state); the job tables are transport and retry machinery, never truth. Any process can crash at any point and a fresh worker resumes from the row — the restartability ADR-0002 already demands.
2. **`signal` and `cancel` are data.** Ingress (the Vercel webhook, ADR-0002) persists a signal row / enqueues a job; the factory picks it up. Cancellation flips run state plus cancels queued jobs, with cooperative checks inside long stage handlers. `status` is a SQL read. This matches ADR-0002's "the seam is data, never code."
3. **Long agent sessions are modeled as start-work → handle-completion transitions** where the sandbox allows it, rather than one multi-hour blocking job; where a stage must block (streaming `codex exec --json` logs), the job carries a heartbeat/expiration so a dead worker's job reappears.
4. **What we now own:** idempotent transition handlers, retry/timeout/zombie semantics, and exactly-once side effects (draft-PR creation, sandbox provisioning) guarded by state checks — the engineering cost the findings priced into this option, accepted deliberately at single-tenant scale (ADR-0001: one operator, one container through M6).

Not chosen: Workflow SDK Postgres World (second state store, young backend, compiler magic), Inngest (external engine state, Connect beta, SSPL/pricing), Trigger.dev (third deploy target). All remain documented fallbacks; the `WorkflowProvider` interface is retained so a future backing swap replaces the provider, accepting that workflow bodies would move too.

### Consequences

- No new vendor, no second state store, no license or pricing exposure: MIT pg-boss plus the Postgres that #61 already had to provide (pg-boss requires Postgres 13+, Node 22.12+).
- Run state is plain SQL — joinable with the rest of the factory schema for the §20 observability queries, and the ADR-0003 transition-table test runs against the same reducer production uses.
- The correctness burden (idempotency, resumable half-finished stages) is ours forever; the mitigations are the transition-table tests and the data-shaped seam. If v1 outgrows this, the recorded escalation path is Workflow SDK Postgres World or Temporal — a rewrite of workflow bodies behind the same provider interface.
- Plan §8's "eve / Vercel Workflow can provide durable infrastructure underneath" is superseded for v1: eve is not used; the plan is annotated accordingly.
