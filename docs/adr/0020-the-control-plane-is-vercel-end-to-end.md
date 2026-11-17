# ADR-0020: The control plane is Vercel end to end — no long-lived worker container

- Status: Accepted
- Date: 2026-09-17

## Context

[ADR-0002](archive/0002-control-plane-is-hybrid-vercel-ingress-plus-worker-container.md) split the control plane in two: Vercel hosts the ingress surface, a long-lived Node worker container hosts the factory.

## Decision

**The v1 control plane runs entirely on Vercel: the ingress surface and the factory both, with no long-lived worker container.**

- §1 — Vercel hosts ingress: — the GitHub App webhook receiver and the thin API.
- §2 — The factory runs as a Vercel Workflow durable execution: The run state machine, the stage handlers, and everything that waits are steps and sleeps inside a run, not a process holding memory.
- §3 — The seam between ingress and factory is data, not code.
- §4 — No stage may block longer than a step.
- §5 — In-memory handles are caches, never the only copy: `SandboxRegistry` and `WorkerSessionRegistry` were correct while one process carried a whole run.

## Consequences

- **One deploy target instead of two.** ADR-0002 priced two as "the accepted cost of the hybrid"; that cost is refunded.
- **ADR-0005 needs a look.** [ADR-0005](0005-monorepo-split-lands-with-the-control-plane.md) decided the monorepo split *because* the control plane was two deploy targets.
- **The internet-facing secret surface widens, and this is the real cost.** ADR-0002 listed as a benefit that sandbox credentials and model keys "live in the worker container's environment, not in the ingress functions, shrinking the internet-facing secret surface." There is no container now, so that separation has to be re-established inside Vercel rather than assumed.
- **Restartability moved, and is not yet proven.** ADR-0002 required the worker container to be restartable at any time.

**Later changes** (full text in Background):

- What flips this to Accepted

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-09-17
- Resolves: [#193 — Decide: amend or supersede ADR-0002 and ADR-0007](https://github.com/jyothepro/orqon/issues/193) (wayfinder map [#50](https://github.com/jyothepro/orqon/issues/50))
- Accepted on 2026-09-19, when #200 deleted `apps/worker`. Supersedes [ADR-0002](archive/0002-control-plane-is-hybrid-vercel-ingress-plus-worker-container.md) §2; its §1 and §3 are carried forward unchanged.
- First live run on this topology: `2329bb84`, 2026-09-19 — a labelled issue to a verified draft pull request in about 8 minutes for $0.32.

### Context

[ADR-0002](archive/0002-control-plane-is-hybrid-vercel-ingress-plus-worker-container.md) split the control plane in two: Vercel hosts the ingress surface, a long-lived Node worker container hosts the factory. It rejected a Vercel-hosted factory on two specific grounds, both quoted here because the question is whether they still hold:

> A 30+ minute blocking step is impossible on Vercel-hosted functions (800s GA / 1800s beta cap) and on any serverless HTTP-serve orchestration mode.

> Streaming a worker's event log out of a sandbox (`codex exec --json` over a detached command's `logs()`) is a long-lived connection — a natural fit for a persistent process, an awkward poll-loop on serverless.

[The Vercel-first plan](../archive/2026-11/vercel-supabase-architecture-plan.md) proposed collapsing the two halves. [The migration map](../archive/2026-11/vercel-workflow-migration-map.md) inspected the code before any of it was written, and two spikes measured the runtime rather than reading its documentation. What they found:

1. **Half the first objection dissolved.** A Vercel Workflow **run** now has no duration limit and `sleep` has no limit. "Any serverless HTTP-serve orchestration mode" is no longer the whole menu.
2. **The other half is unchanged, verbatim.** Pro gets 300 s by default, **800 s maximum**, 1800 s extended and still in beta — the same numbers ADR-0002 cited. Exactly one function depended on exceeding it: `consumeSession()`, which ran for a whole agent session, bounded by ADR-0011's 7200 s wall-clock cap — nine times the ceiling.
3. **The second objection's prediction was correct**, and is accepted rather than refuted. #197 restructured `consumeSession()` into one poll per delivery. The poll loop ADR-0002 predicted exists, and it cost a durable summary accumulator (`agent_session_progress`), a `poll` outcome on the stage seam, and a watermarked reader to make it lossless.
4. **The cancellation objection is obsolete.** ADR-0002 recorded programmatic run-cancel as "the weakest part of the managed Workflows API." Spike B measured `getRun(id).cancel()` returning in 167 ms and reaching a step **already executing**.
5. **A new risk replaced it.** That cancel is the *hard* one — the SDK documents it as terminating "with no opportunity for cleanup" — and a Windkeel run holds a live billing sandbox. See [ADR-0021](0021-vercel-workflow-backs-workflowprovider.md) §4.

One mitigation ADR-0002 wrote down turned out to be the reason this is affordable at all: *"the seam is data-shaped, so collapsing to a single host later is a bounded move, not an unwind."* It was, and #194 proved the load-bearing half of it by destroying the job schema outright and showing no run fact went with it.

### Decision

**The v1 control plane runs entirely on Vercel: the ingress surface and the factory both, with no long-lived worker container.**

Concretely:

1. **Vercel hosts ingress** — the GitHub App webhook receiver and the thin API. Carried forward from ADR-0002 §1 **unchanged**. It was never the contested half.
2. **The factory runs as a Vercel Workflow durable execution.** The run state machine, the stage handlers, and everything that waits are steps and sleeps inside a run, not a process holding memory. `apps/worker` and its Dockerfile are deleted by #200.
3. **The seam between ingress and factory is data, not code.** Carried forward from ADR-0002 §3 **unchanged**, and it is now load-bearing in a second way: a step is a separate invocation, so anything a stage needs must be readable from Postgres rather than held.
4. **No stage may block longer than a step.** This *replaces* ADR-0002 §4, which told #60 that "Vercel function step caps do not constrain it." They do now, and that constraint is the shape of the whole design: a stage that cannot finish returns `poll` and the provider does the waiting, inside the durable execution where `sleep` is unlimited. The arithmetic for the one stage that needed it is in `session-turn.ts`, stated so it can be checked rather than believed.
5. **In-memory handles are caches, never the only copy.** `SandboxRegistry` and `WorkerSessionRegistry` were correct while one process carried a whole run. With steps as separate invocations they are same-process caches: a sandbox is re-acquired by name (#196), and what cannot be re-acquired fails by name rather than falling back to something different wearing the same label.

Not chosen: keeping the worker container beside Vercel Workflow (two deploy targets *and* a second orchestration path — the cost of the hybrid with none of its reason); a non-Vercel host for the whole thing (a bigger move than the evidence supports, and the sandbox is Vercel's either way).

### Consequences

- **One deploy target instead of two.** ADR-0002 priced two as "the accepted cost of the hybrid"; that cost is refunded.
- **ADR-0005 needs a look.** [ADR-0005](0005-monorepo-split-lands-with-the-control-plane.md) decided the monorepo split *because* the control plane was two deploy targets. One of its two `apps/` disappears. The split may still be right for other reasons — `packages/verification`'s zero-dependency boundary is untouched — but the reason recorded is no longer the reason that applies. Not decided here.
- **The internet-facing secret surface widens, and this is the real cost.** ADR-0002 listed as a benefit that sandbox credentials and model keys "live in the worker container's environment, not in the ingress functions, shrinking the internet-facing secret surface." There is no container now, so that separation has to be re-established inside Vercel rather than assumed. [ADR-0014](0014-sandbox-secrets-brokered-keys-scoped-tokens-phased-egress.md) §1 is unaffected — no model key ever enters a sandbox, and brokering at the egress proxy is unchanged — but ADR-0008 §4's secret-surface split is about *deployments*, and there is one fewer.

  **Answered by [#213](https://github.com/jyothepro/orqon/issues/213), and the answer is that it cannot be re-established.** Two facts, both read out of the SDK rather than assumed:

  1. `@workflow/world-vercel` addresses every queue message to the **producer's own** deployment — `const deploymentId = opts?.deploymentId ?? process.env.VERCEL_DEPLOYMENT_ID`, with the module's own header explaining why: "queue messages are addressed to one so replays land on the code that created the run, and encryption keys are derived per deployment." A webhook in project A that calls `start()` addresses the message to project A, which has no flow function. **Producer and consumer must therefore be one deployment**, so the obvious fix — the webhook in one Vercel project, the workflow runtime in another — is not available.
  2. Vercel scopes environment variables per project and environment, not per function. There is no per-function scoping to fall back on.

  So the precise residual risk, stated rather than mitigated: **every function in the ingress deployment can read `VERCEL_TOKEN`, the model keys, and the App private key, including the internet-facing GitHub webhook — which needs none of them.** Under ADR-0002 the webhook deployment held none of the three.

  What is unchanged: ADR-0014 §1 (no model key ever enters a sandbox; brokering at the egress proxy), ADR-0014 §2 (the verifier's token is read-only by construction), and the rule that token values are never logged, persisted, or placed in an evidence package. The widened surface is *ambient availability inside one deployment's function environment*, not a new path out of it.

  The real reduction available later is to stop holding a static `VERCEL_TOKEN` at all — exchanging Vercel's OIDC token for a short-lived sandbox credential per run — which narrows the blast radius of the one credential that both creates sandboxes and outlives any run. That is not #213's scope and is not done.

  This no longer blocks #176's credentials. It is a cost to accept knowingly, and the deployment should be treated as holding production secrets on every route.
- **Restartability moved, and is not yet proven.** ADR-0002 required the worker container to be restartable at any time. That obligation is now the SDK's, and `VercelWorkflowProvider` declares `reclaimsExpiredJobs: false` because nothing has observed a step invocation dying mid-execution and being redelivered. A run stranded that way holds a live sandbox; #198's reaper is the backstop, not the fix.
- **Local development survives, which was not guaranteed.** [ADR-0016](0016-local-development-hermetic-by-default.md) made hermetic local dev a requirement, and pg-boss over dockerized Postgres was how it was met. The Workflow SDK resolves its backing through a pluggable World, and `@workflow/world-local` keeps runs, steps and streams on disk — so the conformance suite runs the real runtime locally and in CI with no Vercel account. ADR-0016 holds.
- **A beta dependency on a load-bearing path.** `workflow@5.0.0-beta.53`. The plan classifies this decision as a medium/high door and the SDK is pre-GA; that is a risk accepted here explicitly rather than discovered later.
- **`windkeel doctor`'s worker checks and ADR-0015's retention sweep needed somewhere to live.** Both moved to `src/factory/sweeps/` ahead of the deletion (#209), sharing one advisory lock helper with #198's reaper. Advisory locks still require a session-mode Postgres connection, so [ADR-0008](0008-supabase-postgres-and-storage-sql-file-migrations.md) §1's two-connection-string split survives for a reason that has nothing to do with pg-boss.

### What flips this to Accepted

Three things, all of which also unblock #200's deletion half:

1. A real run carried end to end by the Vercel backing — conformance is not production.
2. ~~[#210](https://github.com/jyothepro/orqon/issues/210)~~ — done: `worker_session_binding` (migrations/0014) carries the session reference across invocations, and a handler-level test drives a repair delivery in a process that never held the session.
3. ~~The secret-surface question above, answered.~~ Answered by #213: it cannot be re-established inside Vercel, and the residual risk is recorded above. This no longer gates the flip.

Until then `WINDKEEL_WORKFLOW_BACKING` defaults to pg-boss, ADR-0002 stays Accepted, and this record is Proposed — because the repository should not claim a topology it has never run.
