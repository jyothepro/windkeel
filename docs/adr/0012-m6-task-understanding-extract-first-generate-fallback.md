# ADR-0012: M6 task understanding — extract first, generate as approved fallback

- Status: Accepted
- Date: 2026-08-17

## Context

ADR-0003 fixes `EngineeringTask.acceptance_criteria` as the engine's `Criterion[]`, extracted once at task creation and passed as `VerificationRequest.criteria`; plan §25 puts "understand the task, create acceptance criteria" in the first product, while §12's full planner (risk classification, subtask decomposition, worker selection) is a later milestone and out of scope.

## Decision

**Task creation extracts criteria deterministically; only a zero-criteria issue triggers LLM generation, which runs on the checker's side and waits for operator approval; with no approved criteria there is no run.**

- §1 — Extract first: Task creation runs `extractCriteria` over the issue body.
- §2 — Generation triggers only on zero: The fallback fires exactly when extraction finds nothing.
- §3 — The checker's side generates: The generation step runs on the checker-default model (Anthropic, ADR-0010), never the maker's vendor — the model that writes the code must not author the yardstick it is measured against.
- §4 — Only generated criteria wait for approval: The App posts the generated criteria as an issue comment and the run holds at `WAITING_FOR_APPROVAL` (existing ADR-0003 state, existing transitions — no state-machine change).
- §5 — No criteria, no run: If generation produces nothing usable, or the operator never approves, the run ends `CANCELLED` with an issue comment saying why (no verifiable acceptance criteria).
- §6 — Scope guard: This is the whole M6 slice.

## Consequences

- The common case — an issue with a checklist — costs zero model calls and zero waiting: author-written criteria flow straight through, and approval friction lands only where the machine guessed.
- #74 builds exactly this: the zero-trigger, checker-side generation, the criteria comment, `/windkeel approve` handling, and the `CANCELLED`-with-reason exit.
- ADR-0009 is amended by one command (`/windkeel approve`); ADR-0003 is untouched — the gate lives entirely in existing states and transitions.
- Criteria provenance is recordable per task (extracted vs generated-and-approved), which the §16 evidence summary can surface so a reviewer knows whose words the PR was verified against.

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-08-17
- Resolves: [#72 — Decide the Milestone 6 task-understanding slice: issue → acceptance criteria](https://github.com/jyothepro/orqon/issues/72) (wayfinder map [#50](https://github.com/jyothepro/orqon/issues/50))

### Context

ADR-0003 fixes `EngineeringTask.acceptance_criteria` as the engine's `Criterion[]`, extracted once at task creation and passed as `VerificationRequest.criteria`; plan §25 puts "understand the task, create acceptance criteria" in the first product, while §12's full planner (risk classification, subtask decomposition, worker selection) is a later milestone and out of scope. The engine already owns deterministic extraction (`extractCriteria` in `src/stages/intent.ts`), and the surrounding decisions constrain the slice: ADR-0009 fixes the GitHub surface (the `windkeel` label, `/windkeel cancel`, comment conventions), ADR-0010 fixes the model wall (Codex/OpenAI makes, Anthropic checks, independence run-fatal), and issue #74 sketched an approval gate holding machine-generated criteria at `WAITING_FOR_APPROVAL` — a state ADR-0003 already has.

The open questions: is verbatim extraction enough for M6; if a generation step exists, which model runs it; which criteria need human sign-off; and what a zero-criteria issue does to the run.

### Decision

**Task creation extracts criteria deterministically; only a zero-criteria issue triggers LLM generation, which runs on the checker's side and waits for operator approval; with no approved criteria there is no run.**

1. **Extract first.** Task creation runs `extractCriteria` over the issue body. One or more extracted criteria are the task's `acceptance_criteria` verbatim — the author's own words — and the run proceeds directly toward `PROVISIONING` with no model call and no approval pause.
2. **Generation triggers only on zero.** The fallback fires exactly when extraction finds nothing. No model-judged "weakness" sits in the trigger path: identical issues always take identical paths, and the trigger is unit-testable. Augmenting or second-guessing author-written criteria is planner-milestone territory.
3. **The checker's side generates.** The generation step runs on the checker-default model (Anthropic, ADR-0010), never the maker's vendor — the model that writes the code must not author the yardstick it is measured against. This reuses the worker container's existing checker credential; no new key or config slot.
4. **Only generated criteria wait for approval.** The App posts the generated criteria as an issue comment and the run holds at `WAITING_FOR_APPROVAL` (existing ADR-0003 state, existing transitions — no state-machine change). **`/windkeel approve`** advances to `PROVISIONING`; `/windkeel cancel` ends the run `CANCELLED`. To steer rather than accept or reject: cancel, edit the issue to contain explicit criteria, and re-label — the fresh run (ADR-0003: recovery is a new run) then extracts instead of generating. This adds `/windkeel approve` to ADR-0009's command list (amendment noted there); the comment handler already subscribes to `issue_comment`.
5. **No criteria, no run.** If generation produces nothing usable, or the operator never approves, the run ends `CANCELLED` with an issue comment saying why (no verifiable acceptance criteria). There is no checks-only verification mode: a "verified draft PR" whose verification never asked what the issue wanted would hollow out the product promise. The retry path is ADR-0009's existing one — edit the issue, re-add the `windkeel` label.
6. **Scope guard.** This is the whole M6 slice. Risk assessment beyond the operator-set `risk_level`, subtask decomposition, implementation planning, and worker selection stay in the planner milestone. Implementation of the gate and generation step is tracked as #74.

### Consequences

- The common case — an issue with a checklist — costs zero model calls and zero waiting: author-written criteria flow straight through, and approval friction lands only where the machine guessed.
- #74 builds exactly this: the zero-trigger, checker-side generation, the criteria comment, `/windkeel approve` handling, and the `CANCELLED`-with-reason exit. Its test shapes follow directly (an issue with criteria never generates; a zero-criteria issue holds at `WAITING_FOR_APPROVAL`; approval provisions; cancel/timeout never does).
- ADR-0009 is amended by one command (`/windkeel approve`); ADR-0003 is untouched — the gate lives entirely in existing states and transitions.
- Criteria provenance is recordable per task (extracted vs generated-and-approved), which the §16 evidence summary can surface so a reviewer knows whose words the PR was verified against.
- A vague issue cannot silently burn a run's spend on a misread: the misread is visible in the criteria comment before a sandbox is ever provisioned, and rails (ADR-0011) bound whatever is approved.
