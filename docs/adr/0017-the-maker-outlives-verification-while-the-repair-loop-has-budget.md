# ADR-0017: The maker workspace and its worker session outlive verification while the repair loop has budget

- Status: Accepted; amended by ADR-0029 (proposed)
- Date: 2026-09-05

## Context

ADR-0011 §2 says a repair attempt resumes **the same** worker session with the new `RepairPacket`, and nothing escalates between attempts.

## Decision

**The maker workspace and its worker session are held alive across `VERIFYING` whenever the repair loop still has budget, and are destroyed on every other exit. Teardown becomes a property of the control flow rather than a call a handler remembers to make.**

- §1 — Held, not re-provisioned: On a `fail` verdict that survives `enforceRepairLoopRails`, the verifier is destroyed and the maker is kept — sandbox and `WorkerSession` both.
- §2 — `WorkerSessionRegistry`: (`src/factory/workflow/session-registry.ts`) carries the session between deliveries — the sibling of `SandboxRegistry`, with the same in-process limitation stated the same way.
- §3 — A session that cannot be resumed is a named, honest failure, never a silent cold start.
- §4 — One loop exit, not nine: `handlers/loop-exit.ts` owns the single implementation of "the run's hold on its resources ends".
- §5 — Idle time is charged as it accrues: `chargeSandboxUsage` records the *delta* since the workspace was last charged, reading the already-charged figure back from the append-only `cost_event` ledger rather than an in-memory counter.
- §6 — `Workspace.expires_at` remains the backstop: and it is now the thing that bounds a run whose process died mid-loop.

## Consequences

- ADR-0004 is untouched.
- ADR-0011 §2 is implemented rather than amended.
- IMPLEMENTING gains a teardown it did not have.
- The cost of the decision, stated plainly: a maker sandbox is now idle for the duration of every verification in a repairing run.

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-09-05
- Resolves: [#141 — M5.1 Repairable maker: keeping the worker session alive across the verify cycle](https://github.com/jyothepro/orqon/issues/141)
- Amends: ADR-0004's teardown posture (not its independence rule); ADR-0011 §2 is satisfied literally, not amended

> Amended by [ADR-0029](0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md) (Proposed): the maker sandbox is also held while its run is in `HUMAN_EDITING`, under the same spend cap, so a hand-back can resume it.

### Context

ADR-0011 §2 says a repair attempt resumes **the same** worker session with the new `RepairPacket`, and nothing escalates between attempts. Milestone 4 shipped a loop that cannot honour that, and did so knowingly: `verifying.ts`'s `teardownAll` destroys **every** live workspace for the run on the pass path, the fail path, and the exception path, and `implementing.ts` records the matching debt in its header ("teardown is VERIFYING's debt to pay") on the assumption that no further turns follow a verification.

By the time a `fail` verdict exists, then, two things a repair turn needs are gone:

1. **The maker sandbox.** `SandboxProvider` has no `attach()`; a `SandboxHandle` is a live object wrapping an SDK client, not a serializable reference. Destroyed means gone, and the Codex thread on its filesystem goes with it.
2. **The in-process handle that addresses the session.** A `WorkerSession` is reachable only from the adapter instance that created it, inside one stage delivery. REPAIRING is a different delivery of a different job. `CodexWorkerAdapter.send()` names all three of these as real failure modes — "the sandbox is gone" is called out there as "a plausible M5 scenario, not a hypothetical".

So M5 cannot begin until the maker's lifetime across `VERIFYING → REPAIRING → VERIFYING` is decided. ADR-0004 (the verifier is fresh, independent, cloned from the remote at the candidate SHA) is unaffected by the answer either way — it is about where the *verifier* comes from, not about what happens to the maker — but ADR-0011 §4/§5 are not: a sandbox kept alive bills against the spend cap and the wall clock, and ADR-0013 requires every sandbox-second to reach the cost ledger.

### Decision

**The maker workspace and its worker session are held alive across `VERIFYING` whenever the repair loop still has budget, and are destroyed on every other exit. Teardown becomes a property of the control flow rather than a call a handler remembers to make.**

1. **Held, not re-provisioned.** On a `fail` verdict that survives `enforceRepairLoopRails`, the verifier is destroyed and the maker is kept — sandbox and `WorkerSession` both. ADR-0011 §2 is then satisfied literally: the repair turn is a resume of the same session, in the same workspace, on the same model.

   The alternative — tear down and re-provision a fresh maker per attempt, driving a **cold** turn from the packet alone — was weighed and rejected. It is cheaper (no idle sandbox during a verification that can run for many minutes) and simpler (one exit path, not nine). But it contradicts ADR-0011 §2 as written, so taking it would have required amending that ADR rather than implementing it, and it discards the thing that makes a repair turn worth more than a fresh attempt: the agent's memory of what it already tried. We would rather pay for idle sandbox time, bounded by rails that now see it, than silently ship a weaker loop under the same name.

2. **`WorkerSessionRegistry`** (`src/factory/workflow/session-registry.ts`) carries the session between deliveries — the sibling of `SandboxRegistry`, with the same in-process limitation stated the same way.

3. **A session that cannot be resumed is a named, honest failure, never a silent cold start.** If the worker process restarted, the registry has no entry, there is no `attach(workerSessionId)` on `WorkerAdapter` any more than there is one on `SandboxProvider`, and the run ends at **`FAILED` with `stop_reason = "error"`** — the same posture `implementing.ts` already takes for a maker workspace whose handle is gone. A cold turn presented as a resume would make ADR-0011 §2's central claim untestable.

4. **One loop exit, not nine.** `handlers/loop-exit.ts` owns the single implementation of "the run's hold on its resources ends". Handlers compute a `StageResult` — an outcome plus `repairLoopContinues` — and release nothing themselves; `settleStage` decides from that result alone, on both ways out of a delivery (a computed result, or a throw). The exits this covers are pass, warn, repair cap, stuck, spend cap, wall-clock cap, cancellation, an unresumable session, an empty change, a failed session, and an exception.

5. **Idle time is charged as it accrues.** `chargeSandboxUsage` records the *delta* since the workspace was last charged, reading the already-charged figure back from the append-only `cost_event` ledger rather than an in-memory counter. It runs at the end of every kept-alive cycle and again at teardown. A maker held through a ten-minute verification therefore reaches `EngineeringRun.cost`, and so the ADR-0011 §4 spend cap and §5 wall-clock cap see the spend a long repair loop actually incurs.

6. **`Workspace.expires_at` remains the backstop**, and it is now the thing that bounds a run whose process died mid-loop. It is set at provision time and is not extended by this decision; a repair loop that outlives it fails on an unreachable workspace, visibly, rather than holding a sandbox indefinitely.

### Consequences

- ADR-0004 is untouched. Every verification still runs in a fresh sandbox cloned from the remote at the candidate SHA, and the verifier is a distinct handle from the maker in every case, including the kept-alive one. Nothing in the verifier's construction can now reach the maker, and the tests assert that off the sandbox timeline rather than off a status column.
- ADR-0011 §2 is implemented rather than amended. §4 and §5 gain teeth they did not have: idle sandbox cost was previously invisible until teardown, which for a repairing run meant invisible until the run ended.
- IMPLEMENTING gains a teardown it did not have. Before this, a run that ended *at* IMPLEMENTING — a failed session, a cancellation, an empty change — left its maker sandbox alive for `expires_at` to reclaim, because teardown was VERIFYING's debt and VERIFYING never ran. That was a real leak, and closing it is a direct consequence of making the exit singular.
- The cost of the decision, stated plainly: a maker sandbox is now idle for the duration of every verification in a repairing run. At M5's scale (one operator, one container, tier caps of 3/2/1) that is bounded by construction; if it ever stops being bounded, the lever is the spend cap, which now actually observes it.
- A worker container restart between VERIFYING and REPAIRING ends the run at `FAILED`/`error` instead of continuing. That is a real reduction in resilience against process death, accepted deliberately: ADR-0007's resume claim is about the *run row*, which does resume, and it never covered live sandbox handles. Making `attach()` real — for both the sandbox and the session — is the change that would lift this, and it is an M2/M3 interface question, not something to settle inside an M5 orchestration ticket.
