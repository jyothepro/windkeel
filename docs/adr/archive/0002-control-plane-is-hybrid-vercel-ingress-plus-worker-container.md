# ADR-0002: The control plane is hybrid — Vercel ingress, long-lived worker container for the factory

- Status: Superseded by ADR-0020
- Date: 2026-08-14
- Superseded on 2026-09-19 by [ADR-0020](../0020-the-control-plane-is-vercel-end-to-end.md), when #200 deleted `apps/worker`. §1 (Vercel hosts the ingress) and §3 (the seam is data, never code) are carried forward by it unchanged; what this record decided and ADR-0020 reverses is §2, the long-lived worker container.

## Context

The Windkeel control plane is three things (`research/direction-change/PLAN.md` §8, §15): an API, the GitHub App webhook receiver, and the factory service that drives runs through the state machine.

## Decision

**The v1 control plane is hybrid: Vercel hosts the ingress surface; a long-lived worker container hosts the factory.**

- §1 — Vercel hosts ingress: the GitHub App webhook receiver and the thin API.
- §2 — A long-lived Node worker container hosts the factory service: the `WorkflowProvider`, the run state machine, and everything that blocks or streams — agent-session waits, sandbox log streaming, verification runs, repair loops.
- §3 — The seam between them is data, not code: Ingress does not orchestrate: the webhook handler validates the event, persists/enqueues the resulting task or signal, and returns.
- §4 — Constraint handed to #60 (orchestration backing): the backing must run embedded in, or be drivable from, the worker container.

## Consequences

- Two deploy targets instead of one — the accepted cost of the hybrid.
- #60 is unconstrained by serverless step caps; the full menu from the durable-orchestration findings stays open, including the embedded options the findings rank best for local dev and testing.
- #62's GitHub App gets a permanent, operator-free webhook endpoint on Vercel.
- The worker container is the only component with long-lived state in memory; it must be restartable at any time — which the durability requirement on #60's backing already demands.

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Superseded by ADR-0020
- Superseded on 2026-09-19 by [ADR-0020](../0020-the-control-plane-is-vercel-end-to-end.md), when #200 deleted `apps/worker`. §1 (Vercel hosts the ingress) and §3 (the seam is data, never code) are carried forward by it unchanged; what this record decided and ADR-0020 reverses is §2, the long-lived worker container.
- Date: 2026-08-14
- Resolves: [#55 — Decide where the control plane runs](https://github.com/jyothepro/orqon/issues/55) (wayfinder map [#50](https://github.com/jyothepro/orqon/issues/50))

### Context

The Windkeel control plane is three things (`research/direction-change/PLAN.md` §8, §15): an API, the GitHub App webhook receiver, and the factory service that drives runs through the state machine. Where it runs constrains two open decisions: the orchestration backing under `WorkflowProvider` (#60) and the GitHub App webhook endpoint (#62).

The hosting-relevant facts from the [durable-orchestration findings](../../../research/durable-orchestration/findings.md):

- Factory runs are long (minutes to 1h+) and spend most of their time waiting on sandboxed coding agents. A 30+ minute blocking step is impossible on Vercel-hosted functions (800s GA / 1800s beta cap) and on any serverless HTTP-serve orchestration mode.
- Streaming a worker's event log out of a sandbox (`codex exec --json` over a detached command's `logs()`) is a long-lived connection — a natural fit for a persistent process, an awkward poll-loop on serverless.
- The fully embedded Postgres-native orchestration shapes (pg-boss, Workflow SDK `@workflow/world-postgres`) explicitly require a long-running Node server and are not serverless-compatible.
- The GitHub App webhook needs a stable public HTTPS endpoint that is cheap to keep up permanently.
- Vercel Sandbox is driven via access token + SDK from anywhere ([vercel-sandbox findings](../../../research/vercel-sandbox/findings.md) §5) — nothing about the sandbox choice requires Vercel hosting.

ADR-0001 bounds the problem: one operator, no hosted signup, no multi-tenant scaling requirement before the Product UI milestone.

Three shapes were compared: everything on Vercel (lowest ops, but every agent wait must be modeled as hook/poll steps and programmatic run-cancel is the weakest part of the managed Workflows API today), everything on one long-lived Node host (simplest topology), and a hybrid. The operator chose the hybrid.

### Decision

**The v1 control plane is hybrid: Vercel hosts the ingress surface; a long-lived worker container hosts the factory.**

Concretely:

1. **Vercel hosts ingress**: the GitHub App webhook receiver and the thin API. This is the stable public HTTPS endpoint #62's GitHub App points at — always up, scale-to-zero cheap, no server to keep patched for the internet-facing surface.
2. **A long-lived Node worker container hosts the factory service**: the `WorkflowProvider`, the run state machine, and everything that blocks or streams — agent-session waits, sandbox log streaming, verification runs, repair loops. One container (Fly.io, Railway, Render, or a VM — the specific platform is an ops choice, not an architectural commitment). ADR-0001 means one container is enough through Milestone 6.
3. **The seam between them is data, not code.** Ingress does not orchestrate: the webhook handler validates the event, persists/enqueues the resulting task or signal, and returns. The factory service picks work up from durable storage. Nothing on the Vercel side ever holds a blocking step of a run.
4. **Constraint handed to #60 (orchestration backing):** the backing must run embedded in, or be drivable from, the worker container. Vercel function step caps do not constrain it — the embedded Postgres-native shapes (pg-boss, Workflow SDK Postgres World) are fully available, as are external engines. If any Vercel-hosted workflow steps are used on the ingress side, they must never block on agent work.

### Consequences

- Two deploy targets instead of one — the accepted cost of the hybrid. The mitigations: the seam is data-shaped, so collapsing to a single host later (or expanding the Vercel side) is a bounded move, not an unwind.
- #60 is unconstrained by serverless step caps; the full menu from the durable-orchestration findings stays open, including the embedded options the findings rank best for local dev and testing.
- #62's GitHub App gets a permanent, operator-free webhook endpoint on Vercel.
- The worker container is the only component with long-lived state in memory; it must be restartable at any time — which the durability requirement on #60's backing already demands.
- Sandbox credentials (`VERCEL_TOKEN` etc.) and model keys live in the worker container's environment, not in the ingress functions, shrinking the internet-facing secret surface.
