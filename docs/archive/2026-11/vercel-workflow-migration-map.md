# Migration map — Vercel Workflow (Phase 1 of the Vercel-first plan)

Phase 1 of [vercel-supabase-architecture-plan.md](vercel-supabase-architecture-plan.md) asks
for an inspection before any implementation: what exists, what already matches, what must
change, what stays, the risks, and the smallest sequence. This is that map.

Nothing here is implemented yet. The purpose is to make one decision visible before it is
made by accident.

## 0. The finding that should drive the decision

**The 800s step cap is unchanged, and one function depends on exceeding it.**

ADR-0002 §13 rejected a Vercel-hosted control plane citing an "800s GA / 1800s beta cap."
Vercel's current limits are identical: Pro gets 300s by default, **800s maximum**, and 1800s
as an extended maximum still in beta. What *has* changed is that a Workflow **run** now has
no duration limit and `sleep` has no limit, which dissolves the other half of §13's objection
("any serverless HTTP-serve orchestration mode").

So the plan is viable if and only if no single step blocks longer than 800s. Exactly one
place violates that today:

`src/factory/workflow/handlers/session-turn.ts` — `consumeSession()`:

```ts
for await (const event of worker.events(session)) {
  record(summary, changed, event);
  if (stopped) continue;
  if (Date.now() - lastCheck < config.railsCheckIntervalMs) continue;
  lastCheck = Date.now();
  const rails = await enforceSpendAndTimeRails(pool, context.engineeringRunId);
  if (rails.stopped) { /* … */ await worker.cancel(session); continue; }
  if (await context.isCancellationRequested()) { /* … */ await worker.cancel(session); }
}
```

This loop runs for the whole agent session — bounded by ADR-0011's **2-hour** wall-clock cap
(`DEFAULT_WALL_CLOCK_CAP_SECONDS = 7200`), nine times the 800s step ceiling.

It is not merely a long loop. It is simultaneously:

1. the agent's event stream consumer,
2. **the enforcement point for ADR-0011's spend and wall-clock rails**, and
3. **the enforcement point for cancellation** (`/windkeel cancel`, ADR-0009 §3).

Points 2 and 3 are the reason this is not a mechanical refactor. Breaking the loop into
`sleep`-and-poll steps means re-deriving the rails at a poll boundary, in a different
execution model. The file's own header warns about precisely this class of change:

> two copies of a spend cap drift into a system where the first turn is capped and the second
> is not — which is precisely the overnight-loop failure ADR-0011 exists to prevent.

ADR-0002 §14 predicted the shape of the cost in advance: streaming a worker's event log is
"a natural fit for a persistent process, an awkward poll-loop on serverless."

**This is the whole migration.** Everything else below is comparatively mechanical.

## 1. What exists today

| Piece | Where | Notes |
|---|---|---|
| Orchestration seam | `src/factory/workflow/provider.ts` | `WorkflowProvider` + `WorkflowProviderCapabilities` |
| pg-boss implementation | `src/factory/workflow/pg-boss.ts` | `policy: "singleton"` + per-run `singletonKey` serialises a run's stages |
| In-memory fake | `src/factory/workflow/fake.ts` | declares `durableAcrossRestart: false` rather than faking it |
| Stage handlers | `src/factory/workflow/handlers/` | intake, provisioning, implementing, verifying, repairing, candidate-capture, session-turn, loop-exit, pr-creating |
| Sandbox seam | `src/sandbox/provider.ts` | `SandboxProvider.create()` → `SandboxHandle.destroy()` |
| Verifier | `packages/verification/` | **zero runtime dependencies** (test-enforced) |
| Producers of jobs | `apps/ingress/src/windkeel-actions.ts`, `src/commands/task.ts` | both call `send()` |
| Consumer | `apps/worker/src/worker.ts` | `boss.work()` |

## 2. What already matches the target

More than the plan assumes.

- **§1 "Supabase stores product state" is already true and already enforced.** ADR-0007 §1
  makes the `EngineeringRun` row the single authority; `provider.ts` states that jobs are
  "transport and retry machinery, never truth." The plan's warning — "do not make Vercel
  Workflow the only place that knows task state" — describes a mistake this codebase cannot
  make, because no run state lives only in a job. Phase 2 is therefore close to a no-op.
- **§2's `WorkflowEngine` boundary already exists, and is stronger.** The proposed interface
  (`startTask`/`getStatus`/`cancel`) has no capability declaration. `WorkflowProvider` does —
  `durableAcrossRestart`, `retriesFailedStages`, `reclaimsExpiredJobs` — with the fake
  required to tell the truth about them. Adopting the narrower proposed interface would be a
  regression; the existing seam should absorb a Vercel implementation instead.
- **§3's `SandboxProvider` boundary exists** and is already narrow.
- **§8 "preserve the verifier" is structurally guaranteed**, not merely intended:
  `@windkeel/verification` has `dependencies: {}`, enforced by a test.

## 3. What must change

| # | Change | Size | Risk |
|---|---|---|---|
| 1 | Restructure `consumeSession` from blocking stream to detached-start + sleep/poll | **Large** | **High** — carries the ADR-0011 rails and cancellation |
| 2 | `VercelWorkflowProvider` behind the existing `WorkflowProvider` seam | Medium | Low — conformance suite already exists |
| 3 | Move producers (`windkeel-actions.ts`, `task.ts`) to `start()` | Small | Low |
| 4 | Retire `apps/worker` container + `boss.work()` consumer | Medium | Medium — deletes the retention sweep host (#182) and `windkeel-admin doctor`'s worker checks (#178) |
| 5 | Re-express retry/serialisation semantics | Medium | **Medium/High** — `singleton` + `singletonKey` guarantees one stage per run at a time; Workflow's equivalent must be identified, not assumed |
| 6 | Keep agent output in Workflow **streams**, never events | Small if done first | **High if discovered late** — 25,000 events and 10,000 steps per run, and replay must finish in 240s |

## 4. What should remain untouched

- `packages/verification/` — the whole point of §8.
- `migrations/0001_factory_schema.sql` and `run-state-machine.ts` — ADR-0012 §4.
- The ADR-0003 transition table and its four terminal states.
- ADR-0014's credential brokering **unless** AI Gateway is adopted (see risk 3 below).
- The `GitHubClient` seam — §6 explicitly permits a direct GitHub App as the implementation.

## 5. Risks

1. **Cancellation may be weaker than the rails require.** ADR-0002 recorded that "programmatic
   run-cancel is the weakest part of the managed Workflows API." ADR-0011's spend cap,
   wall-clock cap, and `/windkeel cancel` are all *built on* mid-flight cancellation. If a Vercel
   Workflow run cannot be cancelled promptly, those rails degrade from enforcement to advice.
   **This must be tested against the real API before Phase 3, not after.**
2. **Event budget.** Codex emits JSONL continuously. Each step costs 3 events minimum; the
   run ceiling is 25,000 events / 10,000 steps, and runs over 2,000 events replay slowly
   against a 240s replay limit. A poll loop at 30s intervals over a 2h cap is ~240 polls — fine
   — but only if agent output goes to streams rather than becoming events.
3. **ADR-0014 §1 is the plan's own "Very High / one-way" row.** "No model key ever enters a
   sandbox" is currently enforced by attaching the key at the sandbox egress proxy. Routing
   models through AI Gateway changes who holds that key and where. This needs its own decision
   before §4 of the plan is implemented.
4. **Workflow run data retention is 7 days on Pro.** Evidence packages live in object storage
   and are unaffected, but *debugging traces* for a failed run expire in a week.
5. **ADR conflict is not a documentation chore.** ADR-0002 is cited by ADR-0005 and ADR-0007;
   ADR-0007's pg-boss decision is superseded outright by §2 of the plan. These need an
   amendment or superseding ADR with dependents updated.

## 6. Smallest implementation sequence

Ordered so the highest-risk unknown is answered first and cheaply.

0. ~~Spike A (sandbox side)~~ and ~~Spike B (Workflow side)~~ — **both done, see §8 and §9.**
   Risk 1 (cancellation) is resolved. A new risk replaces it: hard cancel runs no cleanup, so
   the rails must use the stop-signal shape or a sandbox reaper (§9).
1. Confirm §1/Phase 2 is a no-op by test rather than by reading (it appears to be).
2. Implement `VercelWorkflowProvider` against the existing `WorkflowProvider` seam and run the
   existing conformance suite against it, unchanged. The suite is the acceptance criterion.
3. Restructure `consumeSession`, with the rails and cancellation re-proved by the existing
   rails tests before the execution model changes underneath them.
4. Move producers; run both providers side by side.
5. Retire pg-boss and `apps/worker`, relocating the retention sweep and `windkeel-admin doctor`'s
   worker checks.

## 8. Spike A results (run 2026-09-16, real Vercel Sandbox)

Three questions, answered by observation rather than by reading docs. All three came back
workable, but two carry subtleties that would have caused silent failure if implemented from
the documentation alone.

| Q | Result |
|---|---|
| Q1 — reattach a detached command from a *fresh process* | **Works**, with a caveat below |
| Q2 — does `logs()` replay on reattach? | **Yes, from the start** — but the live tail is lossy |
| Q3 — prompt cancellation mid-flight | **Works** — `kill()` returned in 295–426 ms, command exited |

### Q1: reattachment needs a *name*, not an id

`Sandbox.get()` takes `{ name }`. There is no sandbox id on the client object — `vercel.ts:95`
already documents this and uses `name` as `id`. So a workflow step that reattaches must have
persisted the sandbox **name** plus the **`cmdId`**, and the sandbox must be created with
`persistent: true`.

The repo currently creates sandboxes with `persistent: false` and no explicit name
(`src/sandbox/vercel.ts`), and runs commands with `detached: false`. All three must change.

Verified across genuinely separate `node` processes, with only `name` and `cmdId` passed on
disk: process 1 created and exited, processes 2 and 3 reattached and read output.

### Q2: replay is lossless for settled output, lossy at the live tail — and it heals

This is the finding that matters most, and it is invisible in the type signature.
`LogOutputLine` is `{ data, stream }` — no cursor, no offset, no timestamp.

Measured by emitting `line-N` once per second and looking for gaps in N:

| Read | unique lines | max | gaps |
|---|---|---|---|
| first | 104 | line-121 | 17, all ≥ 97 |
| second, 40 s later | 185 | line-205 | 20, all ≥ 180 |

Lines 97–120 were missing from the first read and **present in the second**. So the loss is
confined to roughly the last ~25 seconds of live output and is repaired by the next replay.

**Design consequence, which must not be discovered later:** a poll may only trust output below
a watermark, discarding the live tail and re-reading it on the next poll. A naive
"read since last chunk count" implementation silently drops agent events — for codex JSONL that
means losing `test_finished` and `file_changed` events, which is precisely the evidence M3.3
exists to capture.

Also: chunk boundaries are **not** stable between reads and can fall mid-line. Counting chunks
is unsafe; the byte stream must be reassembled before splitting on newlines.

### Cost that grows with session length

Every poll re-downloads the entire history, because replay always starts from the beginning.
Over a 2 h session at a 30 s poll interval that is ~240 polls, each averaging half the total
output — quadratic in transfer. A chatty `codex exec --json` session makes this real, and it
argues for a longer poll interval than the current `railsCheckIntervalMs` of 30 s, or for
periodically draining output into object storage and truncating.

### What Spike A does *not* answer

It exercised **Vercel Sandbox only**, not Vercel Workflow. Still open:

- whether a Workflow **run** can be cancelled programmatically mid-flight (ADR-0002 recorded
  this as "the weakest part of the managed Workflows API"; ADR-0011's rails depend on it);
- whether steps survive redeployment;
- whether agent output kept in Workflow **streams** stays within the 25,000-event / 240 s-replay
  budget.

Those need a deployed Workflow project — Spike B.

## 9. Spike B results (run 2026-09-16, deployed Vercel Workflow, `workflow@5.0.0-beta.53`)

A throwaway Next.js project with two workflows, deployed to its own Vercel project — never the
live `windkeel` one. Results:

| Q | Result |
|---|---|
| Q4 — cancel a run mid-flight | **Works.** `getRun(id).cancel()` returned in **167 ms**; status was `cancelled` within 3 s **while a step was mid-execution** (a deliberate 240 s block) |
| Q5 — poll-and-sleep across many steps | **Works.** 20 ticks x 15 s sleeps ran to `completed` in ~350 s, no step near the 800 s ceiling |
| Q6 — event/step budget | **Not measured** — needs real `codex` output volume |

### ADR-0002's cancellation objection is resolved

ADR-0002 rejected a Vercel-hosted control plane partly because "programmatic run-cancel is the
weakest part of the managed Workflows API today." That is no longer accurate: the SDK now ships
inflight cancellation, and cancellation reached a step already executing. ADR-0011's spend cap,
wall-clock cap and `/windkeel cancel` therefore have a mechanism to stand on.

### The risk this surfaces instead: hard cancel runs no cleanup

The SDK documents two cancellation shapes, and the difference matters more here than it would
in most applications:

- **Hard cancellation** — "terminates the run immediately with no opportunity for cleanup."
- **Stop signal** — the workflow exits at the next hook, runs pending cleanup, returns a result.

`getRun(id).cancel()` is the hard one, and it is what the spike measured. In Windkeel, the run
holds a **live Vercel Sandbox**. ADR-0002 §3's shutdown path exists precisely because a
`SandboxHandle` has no `attach()` and a sandbox left behind bills until `expires_at` with no
process able to reach it. **A hard cancel would leak exactly that.**

So cancellation cannot be wired to `cancel()` alone. The rails need the stop-signal shape, with
sandbox teardown as the cleanup — or an out-of-band reaper that destroys sandboxes for cancelled
runs. Spike A showed the teardown itself is cheap: `cmd.kill()` returned in 295-426 ms.

### Setup notes worth keeping

- `workflow@5.0.0-beta.53`; the SDK is still **beta**, which is a dependency risk on a
  "Medium/High door" decision.
- Requires `withWorkflow()` in `next.config.ts`; it injects its own routes
  (`/.well-known/workflow/v1/flow`, `.../webhook/[token]`).
- Vercel CLI **47.2.2+** is required to deploy; 46.1.1 is rejected by the API.
- A union of two workflow functions has no single `start()` overload — branch explicitly.

### Still unmeasured

- **Step survival across redeployment** (the durability claim) was not tested.
- **Event budget** under real `codex exec --json` volume — the 25,000-event and 240 s-replay
  limits are only a risk at real output rates.

## 7. Recommendation

Do step 0 before committing to the plan. It is roughly a day, it touches no existing code, and
it resolves the only two questions that can invalidate the migration: whether a coding session
can be driven by poll-and-sleep within an 800s step ceiling, and whether cancellation is prompt
enough to carry ADR-0011's rails.

If both answers are yes, the rest of the plan is a well-bounded migration over seams that
already exist. If either is no, that is far cheaper to learn now than after pg-boss is removed.
