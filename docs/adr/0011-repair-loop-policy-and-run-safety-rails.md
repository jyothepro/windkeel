# ADR-0011: Risk-tiered repair caps and run safety rails — spend cap, wall-clock cap, stuck detection

- Status: Accepted; amended by ADR-0017, ADR-0029 (proposed), ADR-0037
- Date: 2026-08-17

## Context

Plan §14 caps repair attempts "by policy" and sketches a risk-tiered example; ADR-0003 locks the machinery the policy drives — `VERIFYING → REPAIRING → VERIFYING` as the only cycle, `RepairAttempt` storing the engine's `RepairPacket` verbatim, `MAX_REPAIR_ATTEMPTS_REACHED` as a terminal state distinct from `FAILED`.

## Decision

**Repair attempts are risk-tiered; between attempts nothing escalates; three rails — spend, wall-clock, stuck — stop a run cleanly, each landing in an existing terminal state with a machine-readable reason.**

- §1 — Attempt caps, by `EngineeringTask.risk_level`: low **3**, medium **2**, high **1** — then stop.
- §2 — Between attempts, nothing changes: same worker, same model, the Codex session resumed (`codex exec resume`, ADR-0006) with the new `RepairPacket` verbatim plus the engine's static repair constraints.
- §3 — Stuck detection: each `RepairPacket` is reduced to a fingerprint — the sorted identifier sets of its failed acceptance criteria, failed checks, and blocking security/review/browser findings.
- §4 — Spend cap — required by default: `EngineeringRun.spend_cap_usd`, default **$25**.
- §5 — Wall-clock cap: `EngineeringRun.wall_clock_cap_seconds`, default **7200** (2h) since `started_at`; exceeded → stop before spawning the next stage → `FAILED`.
- §6 — Terminal-state mapping and the ADR-0003 amendment: no new states and no new transitions.
- §7 — Recorded history: per attempt — `attempt_number`, the triggering `verification_run_id`, the spawned repairer `agent_run_id`, the `repair_packet` verbatim, and `result` (all ADR-0003 fields).

## Consequences

- #73 builds exactly this: cap checks before every stage spawn, fingerprint comparison across consecutive packets, and `stop_reason` recording.
- ADR-0003 is amended, not contradicted: `EngineeringRun` gains `spend_cap_usd`, `wall_clock_cap_seconds`, `stop_reason`; one transition's "When" clause widens.
- A stuck stop is signal, not breakage — landing it in `MAX_REPAIR_ATTEMPTS_REACHED` (like the cap) keeps `FAILED` meaning "infrastructure/policy stopped the run" and preserves ADR-0003's distinction.
- The defaults ($25, 2h, tier caps 3/2/1, stuck threshold 2) are policy configuration with per-run override, not constants baked into code — the values can move without a new ADR; the *existence* and semantics of the rails cannot.

**Later changes** (full text in Background):

- Amendment, 2026-09-22 — the cap stays an attempt count ([#257](https://github.com/jyothepro/orqon/issues/257))
- Amendment, 2026-09-22 — the wall clock bounds the machine, and the approval gate bounds the human ([#262](https://github.com/jyothepro/orqon/issues/262))

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-08-17
- Resolves: [#64 — Decide the v1 repair loop policy](https://github.com/jyothepro/orqon/issues/64) (wayfinder map [#50](https://github.com/jyothepro/orqon/issues/50))

> Amended by [ADR-0029](0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md) (Proposed), §2: a person's verification cycles (after taking over) don't spend the repair budget; they have their own cap, `human_cycles_cap`, and the run's spend cap. Nothing changes between attempts still holds for the agent.

### Context

Plan §14 caps repair attempts "by policy" and sketches a risk-tiered example; ADR-0003 locks the machinery the policy drives — `VERIFYING → REPAIRING → VERIFYING` as the only cycle, `RepairAttempt` storing the engine's `RepairPacket` verbatim, `MAX_REPAIR_ATTEMPTS_REACHED` as a terminal state distinct from `FAILED`. The engine already produces the packet and its three static repair constraints (`src/engine/repair.ts`).

A later decision input (the AgentOS blueprint review, recorded on #64) widened the policy beyond an attempt cap: an uncapped agent loop is an unbounded spend instrument (the source's motivating anecdote: one uncapped overnight loop cost $1000), and an attempt cap alone misses the repairer that burns attempts making the same non-progress change. The policy must therefore also cover a **spend cap**, a **wall-clock cap**, and **stuck detection**, and say which terminal state each stop lands in. Implementation is tracked separately as #73; this ADR decides the policy.

ADR-0006 fixes the repair worker (Codex, resumable sessions); ADR-0010 fixes its model. `EngineeringTask.risk_level` exists from Milestone 1 (ADR-0003), so risk-tiering costs nothing even before the risk engine sharpens how the level is assigned.

### Decision

**Repair attempts are risk-tiered; between attempts nothing escalates; three rails — spend, wall-clock, stuck — stop a run cleanly, each landing in an existing terminal state with a machine-readable reason.**

1. **Attempt caps, by `EngineeringTask.risk_level`**: low **3**, medium **2**, high **1** — then stop. Cap reached at a `fail` verdict → `MAX_REPAIR_ATTEMPTS_REACHED` (ADR-0003's existing transition), which hands the task to a human with the full evidence trail.
2. **Between attempts, nothing changes**: same worker, same model, the Codex session resumed (`codex exec resume`, ADR-0006) with the new `RepairPacket` verbatim plus the engine's static repair constraints. No model escalation in v1 — pre-BYOK there is no stronger maker tier to escalate to (ADR-0010), and escalation policy belongs to the planner milestone.
3. **Stuck detection**: each `RepairPacket` is reduced to a fingerprint — the sorted identifier sets of its failed acceptance criteria, failed checks, and blocking security/review/browser findings. If **2 consecutive** attempts produce packets with identical fingerprints (no meaningful delta — the repairer is not moving the failure set), the run stops early in `MAX_REPAIR_ATTEMPTS_REACHED` even though the numeric cap isn't reached. The fingerprint is computed from the stored packets; no new `RepairAttempt` fields.
4. **Spend cap — required by default**: `EngineeringRun.spend_cap_usd`, default **$25**. Before spawning the next `AgentRun`, `VerificationRun`, or `RepairAttempt`, the factory refuses if accumulated `EngineeringRun.cost` ≥ cap. Running uncapped requires an explicit operator confirmation (an unset cap is a deliberate act, never a default). Spend stop → `FAILED`.
5. **Wall-clock cap**: `EngineeringRun.wall_clock_cap_seconds`, default **7200** (2h) since `started_at`; exceeded → stop before spawning the next stage → `FAILED`.
6. **Terminal-state mapping and the ADR-0003 amendment**: no new states and no new transitions. Attempt-cap and stuck stops use `VERIFYING → MAX_REPAIR_ATTEMPTS_REACHED`, whose "When" clause is hereby extended from "cap reached" to "cap reached, or stuck detection fired". Spend and wall-clock stops use the existing `CLASSIFYING … PR_CREATING → FAILED` transition. Every rail stop records why: **`EngineeringRun.stop_reason`** (new field, amending ADR-0003's field list) with values `spend_cap | wall_clock_cap | stuck | repair_cap | error`, null on unstopped runs.
7. **Recorded history**: per attempt — `attempt_number`, the triggering `verification_run_id`, the spawned repairer `agent_run_id`, the `repair_packet` verbatim, and `result` (all ADR-0003 fields). This is sufficient to reconstruct the fingerprint series, the §16 "repair attempts" line, and the escalation story a human sees.

### Consequences

- #73 builds exactly this: cap checks before every stage spawn, fingerprint comparison across consecutive packets, and `stop_reason` recording. Its test shape follows directly — `spend_cap_usd = 0` refuses to spawn anything; two no-delta packets stop the loop.
- ADR-0003 is amended, not contradicted: `EngineeringRun` gains `spend_cap_usd`, `wall_clock_cap_seconds`, `stop_reason`; one transition's "When" clause widens. The transition table itself is unchanged.
- A stuck stop is signal, not breakage — landing it in `MAX_REPAIR_ATTEMPTS_REACHED` (like the cap) keeps `FAILED` meaning "infrastructure/policy stopped the run" and preserves ADR-0003's distinction.
- The defaults ($25, 2h, tier caps 3/2/1, stuck threshold 2) are policy configuration with per-run override, not constants baked into code — the values can move without a new ADR; the *existence* and semantics of the rails cannot.
- The worst-case run cost is now bounded by construction, further clipped by spend and wall-clock caps — the $1000 overnight-loop failure mode is structurally impossible. **The bound is not `max attempts × per-stage cost`, as this line originally read.** §2 resumes the session between attempts, so per-stage cost grows with the attempt number; see the 2026-09-22 amendment below for the shape it actually has.

### Amendment, 2026-09-22 — the cap stays an attempt count ([#257](https://github.com/jyothepro/orqon/issues/257))

**Decision: §1's cap continues to count attempts and gains no spend dimension. §4's run-level spend cap remains the only monetary rail.**

The question was whether a repair budget should be bounded in dollars as well as in attempts, because "3" tells an operator nothing about what 3 costs. It was argued from run `f28748b2` — four turns at $0.55, $0.90, $1.21, $1.56, $4.22 in total, for a one-file documentation change.

**That measurement was wrong, and finding out why is most of this decision.** Every cached input token was being billed at the full uncached rate ([#263](https://github.com/jyothepro/orqon/issues/263)). §2 resumes the maker's session, so turn *n* re-sends the prefix of turns 1…n-1 — and a re-sent prefix is exactly what a provider caches. On those four turns the cached share was 94.8%, 96.2%, 96.7%, 97.1%; across all 21 agent turns on record it is 94.3%. Priced correctly the run cost **$0.69**, not $4.24, and the most expensive run in the system's history is 2.7% of its own $25 cap.

So the premise — that a repair budget is a large, unpredictable sum — did not survive measurement.

Two further findings decided the rest.

**The curve is predictable.** The per-turn increment is flat rather than compounding, at 0.54–0.65× the first turn across four runs (0.54, 0.57, 0.59, 0.64, 0.65). For a first turn costing `f` and a cap of `n`, the whole budget is about `f × (n + 1) × (1 + 0.3n)` — 2.6× for a cap of 1, 4.8× for 2, 7.6× for 3. Checked against `f28748b2`: predicted $0.71 against an actual $0.67 of model spend. An operator with one clean run on their repository can therefore compute what a cap costs, which is the thing a dollar ceiling was proposed to give them.

**The stale figure had already done damage.** $4.24 was quoted in the runbook, in `run-report.ts`, and in this issue, and a rail was being designed against it. That is the argument for fixing the measurement before adding the control, and it generalises: a rail calibrated on a number nobody has checked encodes the error in a durable column and an accepted decision, where it is expensive to remove.

#### The rejected options, and what would change the answer

**A separate per-run repair spend ceiling.** Rejected *for now*, not on its merits — it is the only proposal that actually bounds anything, and it expresses a distinction the run-level cap structurally cannot: whole-run spend cannot tell expensive legitimate first-attempt work from a repair loop grinding. It is also the only option requiring a schema migration, a new `stop_reason` value, a specified interaction between two caps, and this amendment to say which fires first — the most expensive thing here to reverse, proposed for a problem that has not yet occurred. Deferred, with a stated trigger: **when a repository's first turn costs more than about $2 corrected**, a 3-attempt budget is ~$15, the run-level cap can no longer separate the two kinds of spend, and this should be revisited.

**Stopping when the projected next turn would cross the run's cap.** Rejected as premature rather than unsound. The projection is better founded than it looked — the within-run increment is flat to ±7%, so it is a measurement, not an extrapolation from two points. But it can only ever refuse a turn that might have succeeded, and on the measured workload it would never fire. Worth reaching for if the deferred ceiling above is ever needed, since it needs no new configuration.

#### The stale-by-one-turn spend check stays a documented property

Cost is recorded when a turn completes, so `enforceSpendAndTimeRails` cannot see a turn in progress: a run crosses its cap and learns afterwards. Fixing it means incremental usage reporting mid-turn, and a rail able to stop a turn already running is a different behaviour from one that refuses to start the next.

It stays documented, with the overshoot bounded by one turn — about $0.24 against a $25 cap. The condition under which that stops being acceptable is the same one as above: **a repository where a single turn is itself several dollars.** Recorded here so the next person meets the trigger rather than re-deriving it.

`docs/running-the-factory.md`, *What a repair budget costs*, carries the corrected table and the estimating formula.

### Amendment, 2026-09-22 — the wall clock bounds the machine, and the approval gate bounds the human ([#262](https://github.com/jyothepro/orqon/issues/262))

**Decision: §5's wall-clock cap measures *working* time — seconds a run spends in a parking state do not count against it — and the approval gate gains a deadline of its own, default 72 hours, whose expiry is `approval_expired` → `CANCELLED`. §6's `stop_reason` value list is extended accordingly.**

#### What was actually happening

A run parked at `WAITING_FOR_APPROVAL` reached `FAILED` with `stop_reason = "wall_clock_cap"` slightly under two hours after it started, and `/windkeel approve` afterwards produced silence. Nothing said so: not the comment Windkeel posts with the proposed criteria, not the runbook, not this ADR.

It was not one bug but a collision between two correct-sounding statements. §5 measures the cap from `started_at` with no regard for what the run is doing. ADR-0020's flow loop wakes a parked run every 300 s, and the approval handler re-checks the rails on every wake. Neither piece is wrong alone; together they are an undocumented two-hour fuse on the only human-in-the-loop gate the system has.

The handler's own header had already argued the right position and then done the opposite — "the caps exist to stop runaway *consumption*, and a parked run consumes nothing" — while applying the cap anyway. It also named the missing piece: "a sweeper that expires stale gates without waiting for a wake is a real gap." What existed instead was an accidental sweeper with a two-hour period and no operator-visible name.

#### Why the wall clock stops rather than the deadline growing

Raising `wall_clock_cap_seconds` for tasks that park was the cheapest option and is rejected: it buys hours rather than an answer, and leaves one column meaning two things. The cap is a bound on *consumption*, and a run at `WAITING_FOR_APPROVAL` or `WAITING_FOR_HUMAN` holds no sandbox, no session and no model spend. Charging it wall-clock time bounds the person, which is not what §5 was written to do.

`parkedSeconds` derives the exemption from `run_state_transition` rather than storing a counter: the transition log is already the authority for what a run was doing and when (ADR-0007 §1), and a denormalized total would be a second place for the same fact to be wrong. An interval that is still open is closed at *now*, so the exemption applies while a run waits rather than only in retrospect.

The exemption is time only. A run that burned its budget before it parked is still stopped, and still stopped for `spend_cap`.

#### Why expiry is `CANCELLED` and not `FAILED`

§6 sorts rails into two buckets: signal (`MAX_REPAIR_ATTEMPTS_REACHED` — the work ran and verifiably does not pass) and policy or infrastructure (`FAILED`). An unanswered approval is neither. No work ran, nothing failed, and the machine breached nothing — a person was asked and did not answer. That is the same outcome as `/windkeel cancel` and as declining the generated criteria, and it reaches the same terminal state. Putting it in `FAILED` would invite whoever finds it to look for a defect that does not exist.

#### The ceiling on the deadline is the tick budget, not taste

72 hours is chosen so a task filed on a Friday afternoon survives the weekend. What bounds it above is not comfort: a parked run is kept alive by a durable execution that sleeps 300 s up to `MAX_TICKS` (2000) times — 6.94 days — after which the execution ends and a signal arriving later is recorded and never consumed ([#261](https://github.com/jyothepro/orqon/issues/261)). **A gate deadline at or above that is a gate that expires by disappearing**, with no state, no comment and no log. 72 h is about 864 ticks, which leaves the rest of the budget for the work that follows approval.

This is a dependency between an ADR-0011 policy number and an ADR-0020 implementation constant, and it is recorded here because that is exactly the kind of coupling that gets broken by someone changing one of them for good local reasons. `WINDKEEL_APPROVAL_DEADLINE_SECONDS` overrides the default; #261 is where the tick budget itself is addressed.

#### Said where a human will meet it

A bound nobody is told about is a trap rather than a policy, so the deadline is stated in the comment Windkeel posts alongside the proposed criteria — with the date, the duration, and the fact that waiting costs nothing, because an operator who knows only the first two will approve something unread to be safe. Expiry posts its own comment naming what expired. `/windkeel approve` arriving afterwards is answered rather than ignored; before this it was silently dropped, which is indistinguishable from the silence an unauthorised comment deliberately gets.

#### What this does not do

It does not sweep stale gates without a wake. Expiry is still observed on the next wake of a parked run, which the flow loop supplies every 300 s — so in the deployed topology the deadline is accurate to five minutes, and in a topology where nothing wakes a parked run it would not fire at all. A standalone sweep belongs with the operational surface, and #261 is the issue where the parked-run lifecycle is addressed as a whole.
