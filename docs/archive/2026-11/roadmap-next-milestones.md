# Next milestones — Workflow migration, then live proof

Written 2026-09-16, after
[vercel-supabase-architecture-plan.md](vercel-supabase-architecture-plan.md) (the strategy)
and [vercel-workflow-migration-map.md](vercel-workflow-migration-map.md) (Phase 1's
inspection, including both spikes' measured results). This file is the *sequencing* decision
those two documents leave open, so that it survives a context loss.

## Where the project actually is

Milestones 0–6 are code complete. `test/e2e-github-loop.test.js` drives a signed webhook
through the real ingress handler, the real pg-boss provider, real Postgres, and the real
stage handlers, producing a defect, a repair, a second verification, a draft PR, a check run,
a sticky comment, and a `COMPLETED` run.

Three layers of that proof are fakes: `FakeSandboxProvider`, `ScriptedWorkerAdapter`,
`FakeGitHubClient` with locally-signed payloads. **No part of this system has ever talked to
a real external service.** That gap is #176 and #116, and it is why M3–M6 say "code complete"
rather than "done".

## The sequencing decision

Two tracks want the same weeks:

- **Milestone A** — migrate orchestration from pg-boss to Vercel Workflow (the plan, §2).
- **Milestone B** — the live proof (#176, #116, #183).

They collide at exactly one place: #176 step 7, "choose where the worker container runs."
**If A happens, there is no worker container.** Standing one up on Fly/Railway/Render now is
work that A deletes.

**Decision: A before B**, with #176 steps 1–2 (register the App — done — and install it on a
scratch repository) pulled forward, because those are free, stack-independent, and unblock
nothing else.

The cost of the other order is paying the account-setup cost twice and debugging a
first-contact-with-reality run on infrastructure already scheduled for deletion.

## Milestone A — pg-boss to Vercel Workflow

Ordered so the highest-risk unknown is answered first. Each step is a GitHub issue written to
be executed by an agent with no context beyond the issue (#193–#200).

| Step | Work | Risk |
|---|---|---|
| [A0](https://github.com/jyothepro/orqon/issues/193) | **Human.** Amend or supersede ADR-0002 and ADR-0007 | — |
| [A1](https://github.com/jyothepro/orqon/issues/194) | Prove Phase 2 ("Supabase is the source of truth") is a no-op **by test** | Low |
| [A2](https://github.com/jyothepro/orqon/issues/195) | `VercelWorkflowProvider` behind the existing `WorkflowProvider` seam | Low |
| [A3](https://github.com/jyothepro/orqon/issues/196) | `attach()` on the sandbox and worker-session seams | Medium |
| [A4](https://github.com/jyothepro/orqon/issues/197) | Restructure `consumeSession()` to detached-start + sleep/poll | **High** |
| [A5](https://github.com/jyothepro/orqon/issues/198) | Sandbox reaper — destroy sandboxes no process holds a handle to | Medium |
| [A6](https://github.com/jyothepro/orqon/issues/199) | Move producers to the new provider; run both side by side | Low |
| [A7](https://github.com/jyothepro/orqon/issues/200) | Retire pg-boss and `apps/worker`; relocate the retention sweep and doctor checks | Medium |

### Why A3 exists, and why it is not in the migration map

The map identified `consumeSession()` as the whole migration. Re-reading the code for this
roadmap surfaced a prerequisite the map did not name:

`src/factory/workflow/sandbox-registry.ts` and `session-registry.ts` are **in-process maps**.
Both files say so explicitly, and both say why: `SandboxProvider` has a `create()` and no
`attach()`, and `WorkerAdapter` has no `attach(workerSessionId)` either. Today a whole run
is carried by one long-lived process, and those registries are how a sandbox created at
PROVISIONING reaches IMPLEMENTING.

Vercel Workflow steps are **separate invocations**. Every poll of a restructured
`consumeSession()` is a new process. So A4 cannot be attempted until a sandbox and a worker
session can be re-acquired by identity — which is precisely what Spike A proved possible for
the sandbox (`Sandbox.get({ name })`) and what nothing yet proves for the codex adapter.

### The two sharp edges, both measured rather than assumed

1. **Hard cancel runs no cleanup.** `getRun(id).cancel()` is prompt — 167 ms, and it reached a
   step already executing — but the SDK documents it as terminating "with no opportunity for
   cleanup." A Windkeel run holds a live Vercel Sandbox that bills until `expires_at` with no
   process able to reach it. Wiring ADR-0011's caps to `cancel()` alone leaks a sandbox on
   **every** cap trip. Hence A5 (#198).
2. **`logs()` replay drops the live tail.** Measured: lines missing from a first read were
   present 40 s later; the loss is confined to roughly the last 25 s and heals. Chunk
   boundaries are unstable and fall mid-line. A naive "read since last chunk" silently drops
   `test_finished` and `file_changed` events — exactly the evidence M3.3 exists to capture.
   Hence the watermark requirement in A4 (#197).

## Milestone B — the live proof

Unchanged in content, re-sequenced in time. #176 steps 2, 4, 5, 6, then `windkeel-admin doctor` green,
then a labelled issue producing a real draft PR. Then #116 (a real `codex exec` against a
real Vercel sandbox) and #183 (the operator runbook, written *from* that run — deliberately
blocked until one exists).

A7 (#200) changes what #176 step 7 and `windkeel-admin doctor` mean, which is the whole reason A precedes B.

## What Milestone A needs from a human

1. **A0 — the ADR call.** ADR-0007's pg-boss decision is superseded outright by §2 of the
   plan. ADR-0002 is cited by ADR-0005 and ADR-0007, so it has dependents. Amend or
   supersede is a maintainer decision, not a documentation edit.
2. **Vercel Pro**, already held. Note that `workflow@5.0.0-beta.53` is **beta**, on a decision
   the plan itself classifies as a medium/high door.
3. Nothing else. A1–A7 need no new account and no new secret.
