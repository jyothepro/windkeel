# ADR-0021: Vercel Workflow backs WorkflowProvider; Postgres run rows stay authoritative

- Status: Accepted
- Date: 2026-09-17

## Context

[ADR-0007](archive/0007-pg-boss-backs-workflowprovider-postgres-is-authoritative.md) decided two things in one record, and only one of them is being replaced.

## Decision

**`WorkflowProvider` is backed by Vercel Workflow, and the `EngineeringRun` row in Postgres remains the single authoritative run state.**

- §1 — Postgres stays authoritative; the workflow journal holds no run state: Carried forward from ADR-0007 §1 **unchanged and deliberately restated**, because it is the property everything else rests on.
- §2 — `signal` and `cancel` are data: Carried forward from ADR-0007 §2 **unchanged**.
- §3 — Serialisation is a database invariant, not a queue policy: pg-boss guaranteed one stage per run with `policy: "singleton"` plus a per-run `singletonKey`.
- §4 — Cancellation uses the stop signal, never the hard cancel: `getRun(id).cancel()` is never called.
- §5 — Agent output travels in streams, never events: A run's ceiling is 25,000 events and 10,000 steps, and replay slows past ~2,000 events against a 240 s replay limit.
- §6 — Capabilities are declared by observation: `durableAcrossRestart: true` and `retriesFailedStages: true` are each tied to a test.

## Consequences

- **`WorkflowProvider` absorbed the new backing without changing shape**, which is the outcome ADR-0007 designed for when it kept the seam.
- **The correctness burden ADR-0007 accepted is unchanged in kind and moved in location.** Idempotent handlers, exactly-once side effects guarded by state checks, retry semantics: still ours.
- **ADR-0008 §1 survives for a new reason.** Session-mode Postgres was required because pg-boss and advisory locks need it.
- **A known gap, recorded rather than left to be found: [#210](https://github.com/jyothepro/orqon/issues/210).** A repair turn must resume *the same* worker session (ADR-0011 §2).

**Later changes** (full text in Background):

- What flips this to Accepted

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-09-17
- Resolves: [#193 — Decide: amend or supersede ADR-0002 and ADR-0007](https://github.com/jyothepro/orqon/issues/193) (wayfinder map [#50](https://github.com/jyothepro/orqon/issues/50))
- Accepted on 2026-09-19, when #200 deleted the pg-boss provider. Supersedes [ADR-0007](archive/0007-pg-boss-backs-workflowprovider-postgres-is-authoritative.md)'s choice of backing; its Decision §1 (Postgres run rows are authoritative) is carried forward unchanged.

### Context

[ADR-0007](archive/0007-pg-boss-backs-workflowprovider-postgres-is-authoritative.md) decided two things in one record, and only one of them is being replaced.

**The half that is replaced.** pg-boss backs `WorkflowProvider`, embedded in the worker container. That followed directly from ADR-0002's topology — the backing "must run embedded in, or be drivable from, the worker container" — and [ADR-0020](0020-the-control-plane-is-vercel-end-to-end.md) removes the container. ADR-0007 also rejected the Workflow SDK on three specific grounds: a second state store, the youngest Postgres backend of a young product, compiler-transform magic, and "the weakest programmatic cancel." Those are worth answering one at a time rather than waving away:

- **Second state store** — avoided, not by trusting the SDK but by not giving it anything to store. See Decision §1.
- **Programmatic cancel** — measured, not assumed: 167 ms, reaching a step already executing (Spike B). The objection was accurate when written and is not accurate now.
- **Compiler-transform magic** — real, and it bit. A `"use workflow"` function compiles into a bundle running in a `node:vm` sandbox with no `require`, and a module's *top-level imports* are evaluated there whether the workflow uses them or not. Importing `pg` beside the workflow function killed the first tick of the first run with `ReferenceError: require is not defined`. The mitigation is structural — the workflow module imports nothing but `sleep` — and it is a real ongoing constraint, not a solved problem.
- **Young backend** — still true, and now pre-GA rather than merely young: `workflow@5.0.0-beta.53`.

**The half that is not replaced, and must survive verbatim.** ADR-0007 Decision §1: the `EngineeringRun` row is the single authoritative run state, and job tables are "transport and retry machinery, never truth." That property is what made this migration a bounded move rather than an unwind, and #194 turned it from a comment into a test — it drops the pg-boss schema outright, mid-run, and asserts every run fact still reads identically.

### Decision

**`WorkflowProvider` is backed by Vercel Workflow, and the `EngineeringRun` row in Postgres remains the single authoritative run state.**

Concretely:

1. **Postgres stays authoritative; the workflow journal holds no run state.** Carried forward from ADR-0007 §1 **unchanged and deliberately restated**, because it is the property everything else rests on. The durable execution is a loop that reads where the run is, runs the handler for it, and commits what the handler asks — every decision made against Postgres. `workflow_run_binding` (migrations/0011) records *which machinery is carrying a run and whether it is moving*, which is exactly the delta `RunStatus` documents: no run state, no verdict, no cost.
2. **`signal` and `cancel` are data.** Carried forward from ADR-0007 §2 **unchanged**. Ingress persists and returns; the handler observes later.
3. **Serialisation is a database invariant, not a queue policy.** pg-boss guaranteed one stage per run with `policy: "singleton"` plus a per-run `singletonKey`. Vercel Workflow has no equivalent — `start()` always creates a new run, with no dedupe key. This was checked rather than assumed. The replacement is the primary key on `workflow_run_binding.engineering_run_id`: losing the claiming insert *is* the "already under way" answer. An index cannot be misconfigured and holds across deployments, regions and SDK versions.
4. **Cancellation uses the stop signal, never the hard cancel.** `getRun(id).cancel()` is never called. It terminates "with no opportunity for cleanup", and a Windkeel run holds a live Vercel Sandbox that bills until `expires_at` with no process able to reach it — so a cap trip wired to it would leak a microVM every time ADR-0011 did its job. `cancel()` writes the durable latch and then wakes the execution so a parked loop observes it in milliseconds; the latch is durable *before* the wake, so a failed wake costs latency, never correctness.
5. **Agent output travels in streams, never events.** A run's ceiling is 25,000 events and 10,000 steps, and replay slows past ~2,000 events against a 240 s replay limit. A step's argument and return value become events, so the tick boundary carries two scalars and a four-variant result and nothing else. The bound is enforced structurally rather than remembered.
6. **Capabilities are declared by observation.** `durableAcrossRestart: true` and `retriesFailedStages: true` are each tied to a test. `reclaimsExpiredJobs` is **`false`**, because nothing has observed a step invocation dying mid-execution and being redelivered. A false `true` would let a caller conclude such a run self-heals; it does not, and it strands holding a live sandbox.

Not chosen: staying on pg-boss (it requires the container ADR-0020 removes); Temporal or Inngest (ADR-0007's recorded escalation path — a larger move than the evidence calls for, and neither removes the sandbox's dependence on Vercel).

### Consequences

- **`WorkflowProvider` absorbed the new backing without changing shape**, which is the outcome ADR-0007 designed for when it kept the seam. One addition was needed: a `poll` outcome, for a stage making progress it cannot finish in one delivery. `wait` means "nothing will happen until someone acts" and a provider is right to park; `poll` means "something is happening now" and parking would strand it. Every backing implements it, and the shared conformance suite gained a case rather than losing one.
- **The correctness burden ADR-0007 accepted is unchanged in kind and moved in location.** Idempotent handlers, exactly-once side effects guarded by state checks, retry semantics: still ours. What changed is that "the same process" is no longer available as an implicit guarantee.
- **ADR-0008 §1 survives for a new reason.** Session-mode Postgres was required because pg-boss and advisory locks need it. pg-boss goes; the advisory locks under the retention sweep and the sandbox reaper stay, and the transaction pooler silently breaks them — verified empirically, two pooled connections both acquired the same lock.
- **A known gap, recorded rather than left to be found: [#210](https://github.com/jyothepro/orqon/issues/210).** A repair turn must resume *the same* worker session (ADR-0011 §2). The session reference is persisted in `agent_session_progress`, which is cleared when the maker's turn ends — so REPAIRING has nothing durable to attach to, and on this backing every repair turn fails. Under pg-boss one process holds the registry across all three stages and the case does not arise. This is the reason the default has not moved.
- **[ADR-0017](0017-the-maker-outlives-verification-while-the-repair-loop-has-budget.md) is narrowed, not overturned.** Its session-lifetime limitation was "a `WorkerSession` cannot be persisted"; it now can, as a `WorkerSessionRef`. What a reattached session does not restore — `usageByTurn`, `reportedFiles`, `finalMessage` — is declared on the adapter's capabilities rather than discovered, and #197's durable summary accumulator closes it for the maker's turn.
- **A pre-GA dependency on the critical path**, and the compiler-transform constraint above is permanent maintenance: an import added to the workflow module is not a style question, it is how the provider stops working.

### What flips this to Accepted

The same three conditions as ADR-0020, and for the same reason: the two records describe one change and should not be half-true. Specifically for this one, #210 is not optional — a backing on which the repair loop cannot run is not a backing for this system.
