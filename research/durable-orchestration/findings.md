# Durable Orchestration Backings for `WorkflowProvider` (wayfinder #53)

**Date:** 2026-08-14
**Question:** What are the viable backings for the factory service's `WorkflowProvider { startRun, signal, cancel, status }` in v1?
**Context:** Windkeel runs are long (minutes to 1h+), spend most of their time waiting on sandboxed coding agents, must survive process restarts, and drive the run state machine (CREATED → CLASSIFYING → PLANNING → PROVISIONING → IMPLEMENTING → VERIFYING → {PR_CREATING | REPAIRING} → …). Temporal was retired in an earlier architecture pass and is covered only for comparison.

---

## Naming note: "eve" is not the workflow product

The product sometimes referenced as "eve" is **not** Vercel's workflow engine. As of mid-2026 there are three distinct things:

- **Workflow SDK** (npm package `workflow`, a.k.a. Workflow Development Kit / WDK) — the open-source TypeScript framework (`"use workflow"` / `"use step"` directives). Beta Oct 2025, **GA in 2026**, 200k+ weekly downloads. Runs on pluggable backends ("Worlds"): Vercel, Local, and a self-hostable Postgres World. ([workflow-sdk.dev](https://workflow-sdk.dev/), [GA announcement](https://vercel.com/blog/a-new-programming-model-for-durable-execution))
- **Vercel Workflows** — the fully managed platform that runs Workflow SDK code on Vercel Functions + Vercel Queues + managed persistence. GA. ([docs](https://vercel.com/docs/workflows))
- **eve** — Vercel's open-source **agent framework** (public preview, launched at Vercel Ship, June 2026), *built on top of* the Workflow SDK. It is a higher-level "Next.js for agents" layer (sessions, sandboxes, approvals, channels), not a workflow engine we would target directly. ([vercel.com/eve](https://vercel.com/eve), [Introducing eve](https://vercel.com/blog/introducing-eve))

The candidate evaluated below is therefore **Workflow SDK / Vercel Workflows**, not eve.

---

## Comparison table

| Criterion | Vercel Workflows / Workflow SDK | Inngest | Trigger.dev (v4) | Postgres queue + own state machine (pg-boss) |
|---|---|---|---|---|
| **Durability model** | Event-sourced log + **deterministic replay**; steps checkpointed, retried (at-least-once) | **Step memoization** (no full replay); each step = HTTP/worker call, result persisted; at-least-once | Runs execute as processes on Trigger workers; retries per policy; **checkpoint/restore during waits** (cloud) | At-least-once job delivery via `SKIP LOCKED`; state machine rows in Postgres are the checkpoint; you write the resume logic |
| **Survives process restart** | Yes — replay from event log | Yes — resume from memoized step state | Yes — run state on server; crashed attempts retried | Yes — jobs + run state in Postgres; any worker resumes |
| **Signals in** | **Hooks** (`defineHook` / token / webhook resume) | `step.waitForEvent` + events API | **Waitpoint tokens** (SDK/HTTP complete) + input streams | Hand-rolled: events table / pub-sub queue + poll or LISTEN/NOTIFY |
| **Cancellation** | CLI/dashboard `workflow cancel <runId>`; durable AbortSignal controller for in-flight steps; programmatic API less first-class | `cancelOn` event + REST bulk cancel; configurable cancellation deadline | `runs.cancel()` SDK + dashboard | Hand-rolled: cancel flag + pg-boss job cancellation; you define semantics |
| **30+ min single step** | **No on Vercel** (function cap 800s GA / 1800s beta) — must model as hook-wait or poll loop; **yes on self-hosted Postgres World** (your own long-running process) | Not in HTTP `serve` mode (bound by platform timeout); **yes via Connect** (persistent worker, beta) | **Yes** — no platform execution limit; `maxDuration` is user-set active-CPU ceiling | **Yes** — your own worker processes, no limits |
| **Long waits (hours+)** | `sleep` / hooks unlimited; run duration unlimited | `waitForEvent` waits at zero cost | Waits > 5s checkpointed, no compute billed | Trivial (job stays queued / state row waits) |
| **Where it runs** | Managed on Vercel; or **embedded in your own Node server** via `@workflow/world-postgres` (graphile-worker under the hood; not serverless-compatible) | Engine external (cloud or self-host single binary); your code stays in your app (HTTP or Connect worker) | Code deployed to Trigger cloud workers, or self-hosted webapp+supervisor+runners stack; **not embedded** in factory service | Fully embedded in your Node process; Postgres only |
| **Requires specific host?** | Managed = Vercel only; OSS SDK = anywhere with long-running server | No | No (but code runs on Trigger's runners, not yours) | No |
| **Local dev / tests** | Local World (`.workflow-data/`, synchronous, zero config) + CLI/web UI | Inngest Dev Server (`npx inngest-cli dev`) with UI | `trigger dev` CLI (runs code locally; needs a cloud account or self-hosted instance); DEV runs free | Plain Postgres in Docker; ordinary unit/integration tests |
| **Small-scale price** | Hobby: 50k events/mo incl.; on-demand $0.02/1k events + $0.50/GB written + function compute. Self-hosted world: $0 | Free: 50k executions/mo, **5 concurrent steps**; Pro $99/mo (1M exec). Self-host: $0 | Free $5 credits; Hobby $10/mo, Pro $50/mo; per-second compute + $0.25/10k runs; self-host $0 | $0 + existing Postgres |
| **License / lock-in** | SDK open source; determinism/replay model leaks into workflow code; Worlds make backend portable | SDKs open; **server is SSPL with delayed Apache-2.0 (3-yr DOSP)**; step-memoization model leaks | Apache 2.0; task/runner model leaks (code lives on their workers) | MIT; near-zero vendor lock-in, but you own orchestration correctness forever |

---

## 1. Vercel Workflows / Workflow SDK ("workflow" npm, formerly WDK; *not* eve)

**Status:** Workflow SDK GA (100M+ runs, 1,500+ customers, 200k+ npm downloads/week since Oct 2025 beta); Python SDK in beta. ([changelog](https://vercel.com/changelog/open-source-workflow-dev-kit-is-now-in-public-beta), [blog](https://vercel.com/blog/a-new-programming-model-for-durable-execution))

**Durability & restart.** `'use workflow'` functions compile into an orchestrating route; all step inputs/outputs are recorded in an event log; on crash/deploy "the system replays execution deterministically from where it stopped." Each `'use step'` compiles into an isolated route with built-in retries; the workflow suspends (no compute) while a step runs. Skew protection pins in-flight runs to the deployment that created them. ([concepts](https://vercel.com/docs/workflows/concepts))

**Signals & cancellation.** Hooks are first-class: `defineHook<T>()` inside the workflow, `hook.resume(token, payload)` from any route — clean mapping to `WorkflowProvider.signal`. Webhook variant (`resumeWebhook`) exists. Cancellation: in-flight step cancellation via a durable AbortSignal controller ([changelog](https://vercel.com/changelog/workflow-sdk-now-supports-inflight-cancellation)); run-level cancel is exposed via CLI/dashboard (`npx workflow cancel <runId>`) and had a recent bug against the Vercel backend ([issue #1076](https://github.com/vercel/workflow/issues/1076)) — programmatic run-cancel is the weakest part of the API surface today (the public API reference lists `start`, `getRun`, `resumeHook`, `resumeWebhook`; no `cancelRun`). ([API reference](https://workflow-sdk.dev/docs/api-reference/workflow-api))

**Long steps / waits.** On Vercel: run duration and `sleep` are **unlimited**, but an *individual step* is bounded by Vercel Function limits — **300s default, 800s max (GA), 1800s extended max (beta)** on Pro/Enterprise; Hobby caps at 300s. A 30–60 min agent session cannot be one blocking step on Vercel; it must be modeled as "start agent → wait on hook (agent-completion webhook) or bounded poll-loop steps." Other limits: 10,000 steps/run, 25,000 events/run, 240s max replay duration (docs recommend child workflows for long runs). ([pricing/limits](https://vercel.com/docs/workflows/pricing), [function limits](https://vercel.com/docs/functions/limitations))

**Where it runs.** Two very different deployments behind one SDK ("Worlds"):
- **Vercel World** (managed): Vercel Functions + Vercel Queues + managed persistence. Requires hosting the factory's workflow routes on Vercel. Multi-region, observability dashboard included.
- **Postgres World** (`@workflow/world-postgres`): self-hosted, "production-ready" per docs — stores runs/events/steps/hooks in Postgres, uses graphile-worker as the queue, runs **inside your own long-running Node server** (must call `start()`; explicitly not serverless-compatible, and not usable on Vercel). This removes the step-duration cap and the Vercel dependency entirely. ([worlds/postgres](https://workflow-sdk.dev/worlds/postgres), [deploying](https://workflow-sdk.dev/docs/deploying), [npm](https://www.npmjs.com/package/@workflow/world-postgres))

**Local dev/testing.** Local World writes to `.workflow-data/` and processes steps synchronously with zero config; CLI + web UI for run inspection. ([deploying](https://workflow-sdk.dev/docs/deploying), [observability](https://workflow-sdk.dev/docs/observability))

**Pricing (managed).** Billed on Workflow Events (~3 events per step), Data Written, Data Retained: Hobby includes 50k events + 1 GB written/mo; on-demand $0.02/1k events, $0.50/GB written, $0.50/GB-month retained; step compute billed as normal Vercel Functions (Fluid, active-CPU). At Windkeel v1 scale (hundreds of runs/day × dozens of steps) this is single-digit dollars. Retention: 1 day Hobby / 7 days Pro. Self-hosted Postgres World: free. ([pricing](https://vercel.com/docs/workflows/pricing))

**Lock-in surface.** SDK is open source with pluggable backends, so the *engine* is portable (Vercel ↔ Postgres World) — unusually low platform lock-in for a managed offering. What leaks through `WorkflowProvider`: the determinism/replay contract (non-deterministic code must live in steps), the compiler/directive toolchain (build-time transform), and hook token semantics. Ecosystem is young relative to Inngest/Temporal; the compiler magic is a debugging risk.

## 2. Inngest

**Status:** Mature product; 1.0 + self-hosting support announced Jan 2026. ([self-hosting blog](https://www.inngest.com/blog/inngest-1-0-announcing-self-hosting-support))

**Durability & restart.** Step **memoization**, not replay: "each step runs once, its result is persisted, and subsequent executions skip completed steps by injecting their stored results." Each step executes as a separate HTTP request to your app (or over a Connect worker); on failure the function is re-executed "from the point of failure with the state of all previous step executions." At-least-once per step; non-deterministic work must be inside `step.run`. Engine state lives in the Inngest server (cloud or self-hosted), not your DB. ([execution model](https://www.inngest.com/docs/learn/how-functions-are-executed))

**Signals & cancellation.** `step.waitForEvent` suspends until a matching event arrives (approval, webhook, agent-done) "at zero cost, however long it takes" — direct mapping for `signal`. Cancellation: declarative `cancelOn` (event match) plus REST bulk-cancellation API; cancellation deadline recently made configurable. ([durable execution](https://www.inngest.com/platform/durable-execution), [cancellation docs](https://www.inngest.com/docs/features/inngest-functions/cancellation))

**Long steps / waits.** The critical caveat: in the default `serve` (HTTP) mode, **a step is bounded by your platform's HTTP timeout** — fine on a long-running server with generous timeouts, fatal on serverless. **Inngest Connect** (persistent WebSocket worker mode, **public beta**) removes this: "step execution is not bound by platform http timeouts," but requires a long-running server and explicitly does not support serverless runtimes. Waits (`waitForEvent`, `sleep`) are unbounded and free. For Windkeel, a 30-min blocking "run agent session" step needs Connect or a proxy pattern (start agent → `waitForEvent('agent/session.completed')`), the latter of which works fine in plain serve mode. ([Connect docs](https://www.inngest.com/docs/setup/connect))

**Where it runs.** Your function code stays in your own app/process; the orchestration engine is external — Inngest Cloud, or self-hosted: single binary / Docker image bundling all services, SQLite + in-memory by default, external **Postgres + Redis** for production, Helm chart available. Support for self-hosted instances is not guaranteed. ([self-hosting](https://www.inngest.com/docs/self-hosting))

**Local dev/testing.** Best-in-class: `npx inngest-cli dev` runs a local dev server with UI; functions are plain HTTP handlers, easily unit-tested.

**Pricing.** Free: 50k executions/mo (execution = run + each step), **5 concurrent steps** — the concurrency cap is the real small-scale constraint if several agent runs execute steps simultaneously. Pro: $99/mo, 1M executions, 100+ concurrent steps; overages tiered ($25 per +25 concurrent steps). Self-hosted: free. ([pricing](https://www.inngest.com/pricing))

**Lock-in surface.** SDK model (`step.run`/`waitForEvent`) hides well behind `WorkflowProvider`. Engine state is in Inngest's store (harder to inspect/join with Windkeel's DB than a Postgres-native option). **License caveat:** server + CLI are **SSPL with delayed Apache-2.0 relicensing (3-year DOSP)** — worth a legal look if self-hosting is the plan. ([open-sourcing blog](https://www.inngest.com/blog/open-source-event-driven-queue))

## 3. Trigger.dev (v4)

**Status:** v4 GA; adds waitpoints, input streams, run prioritization. Apache 2.0. ([v4 GA](https://trigger.dev/launchweek/2/trigger-v4-ga), [GitHub](https://github.com/triggerdotdev/trigger.dev))

**Durability & restart.** Different shape from the other two: tasks are real long-lived processes on managed workers — no replay or memoization needed *within* an attempt. Durability comes from the platform: runs/attempts tracked server-side; failures retried per retry policy (a retried attempt restarts the task function, so steps inside one task are not individually checkpointed — decompose into child tasks with `triggerAndWait` for finer checkpoints). During waits >5s the run is **checkpointed** and resumed (cloud). At-least-once; idempotency keys supported. ([pricing/checkpoint note](https://trigger.dev/pricing))

**Signals & cancellation.** **Waitpoint tokens**: `wait.createToken({timeout})` → `wait.forToken(tokenId)` inside the run; complete from anywhere via SDK (`wait.completeToken`) or plain HTTP POST to the token URL — clean `signal` mapping, with built-in timeout handling (`result.ok`). Cancellation via `runs.cancel(runId)` SDK/API and dashboard. ([wait tokens](https://trigger.dev/docs/wait-for-token))

**Long steps / waits.** The standout: **no platform-enforced execution time limit**. `maxDuration` is a user-configured ceiling counting only active CPU time (min 5s, no documented max); time spent in `wait.*` doesn't count and isn't billed. 30–60 min agent-session steps are natively fine, even as a single blocking step. ([maxDuration](https://trigger.dev/docs/runs/max-duration))

**Where it runs.** Task code is **deployed to Trigger.dev's managed workers** (`npx trigger deploy`) — it does not run inside the factory service process. Self-hosting exists (webapp + Postgres + Redis, plus supervisor/runner worker containers) but loses warm starts, auto-scaling, and **checkpoints**, and docs stress you assume all operational risk; the self-hosted stack is the heaviest of the four options. ([self-hosting](https://trigger.dev/docs/self-hosting/overview))

**Local dev/testing.** `trigger dev` CLI executes tasks on your machine, but orchestration still goes through a Trigger.dev instance (cloud account or self-hosted webapp) — no fully offline mode. DEV-environment runs are not charged.

**Pricing.** Free: $5/mo usage credits, 20 concurrent runs. Hobby $10/mo, Pro $50/mo ($50 credits, 200+ concurrent runs). Compute per-second by machine size (micro $0.0000169/s … large-2x $0.00068/s) + $0.25/10k run invocations. Since Windkeel's runs mostly wait on external sandboxes (checkpointed waits = $0 compute), small-scale cost is low single digits. ([pricing](https://trigger.dev/pricing))

**Lock-in surface.** Apache-2.0 escape hatch, but the deployment model is the lock-in: tasks live on Trigger's runners with their build system, so `WorkflowProvider` hides the API but not the operational topology (a second deploy target beside the factory service). Migrating away means re-hosting the compute, not just swapping an SDK.

## 4. Plain Postgres queue + hand-rolled state machine (pg-boss)

**Status:** pg-boss v12.x (12.27.0 current), MIT, mature. Requires Postgres 13+ and Node 22.12+. ([pgboss.io](https://pgboss.io/), [npm](https://www.npmjs.com/package/pg-boss))

**Durability & restart.** pg-boss gives "atomic, exactly-once job processing" via `SKIP LOCKED` (exactly-once *pickup*; processing is effectively at-least-once under crashes — a job whose worker dies reappears after its expiration interval). Retries with jittered exponential backoff, dead-letter queues with redrive, cron scheduling, deferral, priorities, and basic job-dependency orchestration. The run state machine itself is *not* provided: Windkeel would persist a `runs` table (current state, step cursor, payload) and advance it in job handlers — every transition is a checkpoint. Restart semantics are transparent: any worker picks up outstanding jobs; correctness (idempotent transitions, exactly-once side effects, resumable half-finished states) is entirely on us.

**Signals & cancellation.** Hand-rolled but simple: `signal` = insert an event row / send a job to the run's queue (or LISTEN/NOTIFY for latency); `cancel` = flip a state column + cancel queued jobs + cooperative checks in handlers. Semantics are exactly what we define — which is both the appeal and the cost.

**Long steps / waits.** No limits: workers are our own long-running Node processes. A 30-min agent session is just a job (with a suitable expiration/heartbeat), or better, "start agent" + "handle agent-done event" as two transitions with no held resources between them — which matches Windkeel's state-machine model naturally.

**Where it runs.** Fully embedded in the factory service (or sibling worker processes); the only infrastructure is Postgres, which Windkeel presumably already runs. No third-party service, no second deploy target, state is directly queryable/joinable with the rest of the factory schema.

**Local dev/testing.** Trivial: dockerized Postgres; deterministic unit tests over the state-machine reducer; integration tests drive real jobs. No dev server, no cloud account.

**Pricing.** $0 beyond existing Postgres.

**Lock-in surface.** Effectively none (MIT, boring SQL tables). The trade is engineering cost: retries, timeouts, heartbeats/zombie detection, idempotency, replayable history, and an ops/observability UI all have to be built and maintained. Adjacent primitives if hand-rolling: **graphile-worker** (also what Vercel's Postgres World uses internally), and Microsoft's new **pg_durable** Postgres extension for durable execution ([overview](https://servergurus.com/blog/pg-durable-postgresql)) — young but a sign this space is commoditizing.

## Briefly: Temporal (retired baseline) and other adjacents

- **Temporal** — the most mature durable-execution engine (full deterministic replay; signals, queries, and cancellation first-class; unlimited activity durations via heartbeats). Retired here for good reasons: heavy self-hosted footprint (server cluster + persistence + visibility store) or Temporal Cloud spend, worker/versioning ceremony, and a large operational surface for a v1. Everything Windkeel needs from it is available in lighter forms above; it remains the fallback if v1 outgrows them.
- **Cloudflare Workflows** — durable engine on Workers/Durable Objects; replay-based; would tie compute to Cloudflare, not evaluated in depth ([comparison](https://workflow-sdk.dev/docs/comparisons/workflow-sdk-vs-cloudflare-workflows)).
- **DBOS Transact** — Postgres-backed durable execution embedded in your Node process (checkpointing into Postgres); philosophically the middle ground between "Postgres World" and hand-rolled; smaller ecosystem.

---

## Decision inputs (no recommendation — see decision ticket)

**Nothing is hard-eliminated**, but hard constraints prune configurations:

1. **"30+ min blocking step" eliminates:** Vercel-hosted Workflows steps (800s GA / 1800s beta function cap) and Inngest HTTP-serve on any serverless host. It does *not* eliminate those products — both handle long agent sessions correctly if the session is modeled as *start-work → wait-for-signal* (hook / `waitForEvent`), which is arguably the right factory design anyway since agents run in external sandboxes. If v1 insists on inline blocking steps: Trigger.dev, pg-boss, Workflow SDK Postgres World, or Inngest Connect (beta) are the viable shapes.
2. **"No new deploy target" preference eliminates:** Trigger.dev cloud (code runs on their workers) and managed Vercel Workflows (factory routes must be on Vercel) — unless the factory is already Vercel-hosted, in which case managed Workflows is the lowest-ops option on the table.
3. **Embedded-in-our-process options** (engine state in our Postgres, no external control plane): pg-boss hand-rolled, Workflow SDK + `@workflow/world-postgres`, DBOS. Of these, Postgres World is notable: it gives the durable-replay programming model *and* Postgres-native state *and* a managed escape hatch (swap to Vercel World) behind the same SDK.
4. **`WorkflowProvider` interface fit:** all four map cleanly — `signal` ↔ hooks / `waitForEvent` / waitpoint tokens / event rows; `cancel` ↔ CLI+abort-controller (weakest: Vercel) / `cancelOn`+REST / `runs.cancel` / hand-rolled; `status` ↔ `getRun` / runs API / runs API / SQL. Residual lock-in is the *programming model* (replay determinism vs memoization vs process model), which no thin interface fully hides — swapping backends later means rewriting workflow bodies, not just the provider.
5. **Cost is a non-factor at v1 scale** (all options ≤ ~$10/mo or free at hundreds of runs/day), with one exception: Inngest free tier's **5 concurrent steps** would throttle parallel runs almost immediately; budget $99/mo (or self-host under SSPL) if Inngest is chosen.
6. **Testing/local-dev ranking** (best to worst): pg-boss (plain Postgres + unit tests) ≈ Inngest dev server ≈ Workflow SDK Local World > Trigger.dev (needs a cloud/self-hosted instance even for local runs).
7. **Maturity risk:** Workflow SDK is GA but ~10 months old (Postgres World younger still; run-cancel CLI bug #1076 is a signal); Inngest Connect is beta; Trigger.dev v4 and pg-boss are the most battle-tested shapes for their respective models.
8. **Open questions for the decision ticket:** Where will the factory service itself be hosted (Vercel vs long-running container)? Is a second deploy target acceptable? Is SSPL acceptable if self-hosting Inngest? How much of the run state machine do we want visible as plain SQL vs inside an engine's opaque store?
