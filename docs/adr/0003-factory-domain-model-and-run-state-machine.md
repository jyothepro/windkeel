# ADR-0003: The Milestone 1 factory domain model and run state machine

- Status: Accepted; amended by ADR-0011, ADR-0013, ADR-0015, ADR-0018, ADR-0029 (proposed)
- Date: 2026-08-14

## Context

Milestone 1 introduces the durable factory entities (`research/direction-change/PLAN.md` §6) and the run state machine (§7).

## Decision

**The §6 entities are locked, composed with — never duplicating — the engine types (`Criterion`, `Verdict`, `RepairPacket`).**

- Entities (numbered 1–6 in Background): `EngineeringTask`, `EngineeringRun`, `AgentRun`, `VerificationRun`, `RepairAttempt` (stores the engine's `RepairPacket` verbatim), `Workspace` (`role: maker | verifier`). All ids are UUIDs; everything is reachable from a repository.
- The run state machine is a closed transition table (`CREATED → CLASSIFYING → PLANNING → [WAITING_FOR_APPROVAL] → PROVISIONING → IMPLEMENTING → VERIFYING → PR_CREATING → PR_READY → WAITING_FOR_HUMAN → COMPLETED`, plus `REPAIRING`, `BLOCKED`, `CANCELLED`, `FAILED`, `MAX_REPAIR_ATTEMPTS_REACHED`). Any transition not in the table is illegal and must be rejected.
- Terminal states are exactly `COMPLETED`, `FAILED`, `CANCELLED`, `MAX_REPAIR_ATTEMPTS_REACHED`; recovery is a new run on the same task.
- The only cycle is `VERIFYING → REPAIRING → VERIFYING`, bounded by ADR-0011's caps (ADR-0029, proposed, adds `HUMAN_EDITING`).
- A `warn` verdict goes to humans with the evidence, never around the repair loop.

## Consequences

- Milestone 1 can implement entities, transitions, and the run service directly from this ADR; #61 maps them to a schema without re-litigating shape.
- The engine types on `main` are the single source of truth for `Criterion`, `Verdict`, and `RepairPacket` — the domain model references them and stores their values, so engine and factory cannot drift apart.
- `RepairAttempt.agent_run_id` and `Workspace.engineering_run_id`/`role` are additions to the plan's §6 sketch; the plan is annotated accordingly.
- The transition table is enforceable as data (a legal-transition set) and testable without any persistence — the M1 run service should ship with exactly that test.

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-08-14
- Resolves: [#56 — Lock the factory domain model and run state machine](https://github.com/jyothepro/orqon/issues/56) (wayfinder map [#50](https://github.com/jyothepro/orqon/issues/50))

### Context

Milestone 1 introduces the durable factory entities (`research/direction-change/PLAN.md` §6) and the run state machine (§7). The plan sketches both but leaves them unlocked: field lists are "suggested", the state diagram shows the happy path plus a bag of exception states with no transition rules, and the relationship to the verification engine types already shipped on `main` is unstated.

What already constrains the model:

- ADR-0001: no `organization_id`; `repository_id` is the top-level scope; primary keys are globally unique UUIDs; all access is repository-scoped.
- `src/engine/types.ts` on `main`: the engine consumes a `VerificationRequest` (with `criteria?: Criterion[]`) and produces a `VerificationResult` (`verdict: Verdict` = `pass | warn | fail`, a sealed evidence package directory, and `repair: RepairPacket | null` — present exactly when the verdict is `fail`).
- `src/engine/repair.ts` on `main`: `RepairPacket` is the structured hand-back the repair loop is built on; a `warn` is presented to humans, never sent around the repair loop.
- ADR-0004 (decided alongside this one): every `VerificationRun` executes in its own fresh sandbox, so a run has more than one workspace.

This ADR is persistence-agnostic; mapping to a schema is #61's job, and repair-cap policy values are #64's.

### Decision

**The five §6 entities are locked as follows, composed with — never duplicating — the engine types on `main`.**

#### Entities and relationships

All `id` fields are UUIDs (ADR-0001). Every entity is reachable from a repository: `EngineeringTask.repository_id` → task → run → everything else.

1. **`EngineeringTask`** — requested engineering work. Fields as §6 (minus `organization_id`): `id`, `repository_id`, `source_type`, `source_reference`, `title`, `description`, `acceptance_criteria`, `risk_level`, `priority`, `status`, `created_at`, `updated_at`. `acceptance_criteria` is the engine's `Criterion[]` (`src/evidence/format.ts`) — what the factory passes as `VerificationRequest.criteria`, so extraction happens once at task creation, not per verification. Task `status` is a coarse projection maintained by the factory service — `OPEN`, `IN_PROGRESS`, `WAITING_FOR_HUMAN`, `COMPLETED`, `FAILED`, `CANCELLED` — derived from its runs; the real machine lives on `EngineeringRun`.
2. **`EngineeringRun`** — one autonomous attempt to complete a task (`task_id`). Fields as §6: `id`, `task_id`, `status` (the state machine below), `plan`, `selected_worker`, `selected_model`, `sandbox_provider`, `started_at`, `completed_at`, `cost`, `final_verdict`. `final_verdict` is the engine `Verdict` of the run's latest `VerificationRun`, denormalized for the common query. A task may have many runs (a human can retry after a terminal failure); at most one is non-terminal at a time.
3. **`AgentRun`** — one worker execution segment within a run (`engineering_run_id`). Fields as §6: `id`, `engineering_run_id`, `worker_type`, `model`, `role` (`planner | implementer | debugger | reviewer | repairer`), `started_at`, `completed_at`, `result`, `token_usage`, `model_cost`.
4. **`VerificationRun`** — one execution of the verification engine (`engineering_run_id`). Fields as §6: `id`, `engineering_run_id`, `candidate_sha`, `policy_version`, `verdict`, `evidence_package_ref`, `risk_summary`, `started_at`, `completed_at`. `verdict` is the engine `Verdict`; `evidence_package_ref` is an object-storage reference to the sealed evidence package (`VerificationResult.out`) — Postgres stores the pointer, never the package (§18).
5. **`RepairAttempt`** — the bridge from a failed verification to the worker that repairs it. Fields as §6 **plus one**: `id`, `engineering_run_id`, `verification_run_id` (the failing run that triggered it), `agent_run_id` (the `role: repairer` `AgentRun` it spawned; null until the repairer starts), `attempt_number`, `repair_packet`, `result`. `repair_packet` is the engine's `RepairPacket` stored verbatim — the same JSON the engine already writes as `repair.json`; the factory must not invent a second repair-instruction format.
6. **`Workspace`** — a provisioned sandbox. Fields as §6 **plus two**: `id`, `engineering_run_id`, `role` (`maker | verifier`), `sandbox_provider`, `provider_handle`, `repository`, `base_sha`, `working_branch`, `status`, `expires_at`. The added fields follow from ADR-0004: one run owns a maker workspace and one verifier workspace per `VerificationRun`, so workspaces must say whose they are and which side of the trust boundary they sit on.

#### Run state machine

States are §7's, unchanged. What this ADR locks is which transitions are legal:

| From | To | When |
|---|---|---|
| `CREATED` | `CLASSIFYING` | run picked up |
| `CLASSIFYING` | `PLANNING` | classified |
| `PLANNING` | `PROVISIONING` | plan ready, no approval gate |
| `PLANNING` | `WAITING_FOR_APPROVAL` | risk policy requires human sign-off before implementation |
| `WAITING_FOR_APPROVAL` | `PROVISIONING` | approved |
| `PROVISIONING` | `IMPLEMENTING` | maker workspace ready |
| `IMPLEMENTING` | `VERIFYING` | worker finished |
| `VERIFYING` | `PR_CREATING` | verdict `pass` or `warn` (a `warn` goes to humans with the evidence, never around the repair loop) |
| `VERIFYING` | `REPAIRING` | verdict `fail`, repair attempts remain (#64 policy) |
| `VERIFYING` | `MAX_REPAIR_ATTEMPTS_REACHED` | verdict `fail`, cap reached |
| `REPAIRING` | `VERIFYING` | repairer finished |
| `PR_CREATING` | `PR_READY` | draft PR exists |
| `PR_READY` | `WAITING_FOR_HUMAN` | evidence summary posted |
| `WAITING_FOR_HUMAN` | `COMPLETED` | human approves/merges |
| `WAITING_FOR_HUMAN` | `CANCELLED` | human rejects |
| any non-terminal | `BLOCKED` | external dependency or operator hold; the run records the state it left |
| `BLOCKED` | state it left | unblocked |
| `BLOCKED` | `CANCELLED` | abandoned |
| any non-terminal | `CANCELLED` | operator cancellation |
| `CLASSIFYING` … `PR_CREATING` | `FAILED` | infrastructure or worker error the machine cannot route around |

Locked properties:

- **Terminal states are exactly** `COMPLETED`, `FAILED`, `CANCELLED`, `MAX_REPAIR_ATTEMPTS_REACHED`. Nothing leaves a terminal state; recovery is a new `EngineeringRun` on the same task.
- **Exception states are exactly** the §7 five: `FAILED` and `CANCELLED` (terminal), `MAX_REPAIR_ATTEMPTS_REACHED` (terminal — distinct from `FAILED` because the work ran and verifiably does not pass, which is signal, not breakage), `BLOCKED` and `WAITING_FOR_APPROVAL` (non-terminal waits on a human).
- The only cycle is `VERIFYING → REPAIRING → VERIFYING`, bounded by #64's caps.
- Any transition not in the table is illegal, and the factory service must reject it — state-machine holes are bugs against this ADR.

> Amended by ADR-0011 (no new states or transitions): `EngineeringRun` gains `spend_cap_usd`, `wall_clock_cap_seconds`, `stop_reason`; the `VERIFYING → MAX_REPAIR_ATTEMPTS_REACHED` "When" widens to "cap reached, or stuck detection fired"; spend/wall-clock rail stops use the existing `→ FAILED` transition.

> Amended by ADR-0015 (no state or transition changes): `VerificationRun` gains `evidence_pruned_at` and `evidence_manifest_digest`, and `evidence_package_ref` becomes nullable — null with a non-null `evidence_pruned_at` means "pruned by retention policy", null with neither means "no package produced".

> Amended by ADR-0013 (no state or transition changes): `EngineeringRun` gains `pr_number`, `pr_merged_at`, `human_commits_after_pr`, and its `cost` is defined as the maintained sum of the run's `cost_event` rows. Two append-only children join the model — `cost_event` (per-stage cost and token attribution) and `run_state_transition` (a row per legal transition, which is also the audit trail for "any transition not in the table is illegal").

> Amended by [ADR-0029](0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md) (Proposed): one non-terminal state, `HUMAN_EDITING`, entered from `IMPLEMENTING`/`REPAIRING` (take over) and `WAITING_FOR_HUMAN` (make changes), leaving to `VERIFYING` (submit), `IMPLEMENTING` (hand back), `BLOCKED` or `CANCELLED`. `WAITING_FOR_HUMAN → HUMAN_EDITING → VERIFYING` is a second cycle beside the repair loop.

### Consequences

- Milestone 1 can implement entities, transitions, and the run service directly from this ADR; #61 maps them to a schema without re-litigating shape.
- The engine types on `main` are the single source of truth for `Criterion`, `Verdict`, and `RepairPacket` — the domain model references them and stores their values, so engine and factory cannot drift apart.
- `RepairAttempt.agent_run_id` and `Workspace.engineering_run_id`/`role` are additions to the plan's §6 sketch; the plan is annotated accordingly.
- The transition table is enforceable as data (a legal-transition set) and testable without any persistence — the M1 run service should ship with exactly that test.
- A `warn` verdict reaching humans instead of the repair loop is now a domain-model invariant, not just engine behavior.
