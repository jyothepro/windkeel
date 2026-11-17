# ADR-0016: Local development is hermetic by default — local execution, replayed webhooks, scripted models

- Status: Accepted
- Date: 2026-08-18

## Context

The full loop spans ingress (Vercel), the factory service and orchestration (a long-lived container, ADR-0002/0007), persistence (Supabase, ADR-0008), and sandboxed execution (Vercel Sandbox, ADR-0004/0006).

## Decision

**Local development is hermetic by default: local execution, replayed webhook fixtures, scripted models, dockerized Postgres and MinIO. Every hosted dependency has an opt-in real-thing escape hatch.**

- §1 — Execution: `LocalExecutionEnvironment` with two separate checkouts.
- §2 — Webhooks: recorded fixtures plus `windkeel dev trigger`.
- §3 — Models: scripted fakes by default.
- §4 — `docker compose up` starts Postgres and MinIO.
- §5 — The rule the escape hatches follow.

## Consequences

- A fresh clone runs the full loop offline with `docker compose up` plus a trigger command — no cloud account, no keys, no cost — which is what makes the loop approachable to develop against at all.
- Determinism by default means local failures are reproducible failures, and the same fixtures serve tests and dev.
- The gap between local and production is explicit and enumerated (isolation, credentials, network policy, real model behavior) rather than discovered in staging.
- Fixtures drift from GitHub's real payloads over time; the tunnel path is how they get refreshed, and a fixture that has never been re-captured is a quiet liability.

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-08-18
- Resolves: [#81 — Decide the local development story for the full factory loop](https://github.com/jyothepro/orqon/issues/81) (wayfinder map [#50](https://github.com/jyothepro/orqon/issues/50))

### Context

The full loop spans ingress (Vercel), the factory service and orchestration (a long-lived container, ADR-0002/0007), persistence (Supabase, ADR-0008), and sandboxed execution (Vercel Sandbox, ADR-0004/0006). None of the *core* is cloud-only by construction — that was a deliberate property of ADR-0007's embedded pg-boss and ADR-0008's stock-Postgres, S3-protocol discipline. What remains open is what a laptop actually runs, and what it substitutes for the parts that are genuinely hosted.

The repo already has the pieces this can be built from: `ExecutionEnvironment` as the execution seam with `LocalExecutionEnvironment` behind it (`src/exec/`), and the bench corpus's scripted model fakes (`WINDKEEL_FAKE_REVIEWER`/`WINDKEEL_FAKE_MAPPER`), which make the whole verification pipeline deterministic without a model call. The test suite's neutral environment already clears provider credentials so no test can accidentally reach a real model.

### Decision

**Local development is hermetic by default: local execution, replayed webhook fixtures, scripted models, dockerized Postgres and MinIO. Every hosted dependency has an opt-in real-thing escape hatch.**

#### 1. Execution: `LocalExecutionEnvironment` with two separate checkouts

The inner loop runs on the existing `LocalExecutionEnvironment` — fast, free, offline, already shipped. Maker and verifier each get **their own temporary checkout**, so ADR-0004's shape survives locally: separate workspaces, verifier cloning fresh from git, no filesystem state passed across the boundary.

**The honest caveat, which the local mode must not obscure:** two directories on one laptop reproduce the *workflow* of independent verification, not its *isolation*. There is no VM boundary, no separate network policy, and no credential separation locally. Local runs can prove the loop is wired correctly; only a real sandbox run proves the trust boundary holds. Real Vercel Sandbox is therefore available behind a flag — the SDK is drivable from any machine with `VERCEL_TOKEN` ([vercel-sandbox findings](../../research/vercel-sandbox/findings.md) §5), at roughly $0.10 per run — and is the required mode for changes that touch provisioning, credentials, or egress policy.

#### 2. Webhooks: recorded fixtures plus `windkeel dev trigger`

Checked-in webhook payload fixtures (`issues.labeled`, `issue_comment.created`, `pull_request.closed`) are replayed by a `windkeel dev trigger <fixture>` command that POSTs them at the local ingress with a valid signature computed from the dev secret. No tunnel, no public URL, no GitHub account needed for daily work — and the ingress handler's real behavior (signature validation, event routing, the `windkeel` label trigger from ADR-0009) is exercised rather than bypassed. The same fixtures are the ingress test corpus, so dev tooling and tests share one source of truth.

A tunnel (smee or cloudflared) against a dev GitHub App is documented for occasional true end-to-end checks, and is where new fixtures come from — capture a real delivery once, commit it, replay it forever.

#### 3. Models: scripted fakes by default

Local runs use the bench corpus's scripted-fake pattern for checker-side calls, and a fake worker adapter that replays a recorded Codex JSONL event stream for the maker. Deterministic, free, offline, and the loop's control flow is exercised without waiting on inference. Real keys are opt-in per invocation for the cases that need them (prompt work, adapter changes against real Codex output). ADR-0010's independence check runs identically against fakes, so it cannot rot unnoticed.

#### 4. `docker compose up` starts Postgres and MinIO

Two containers: **Postgres** (stock, matching Supabase's major version — ADR-0008's discipline is that migrations must run identically here) and **MinIO** (S3-compatible, satisfying ADR-0008's S3-protocol storage seam with only an endpoint and credentials changed). Compose applies the migrations on boot, so a fresh clone reaches a working schema in one command. pg-boss creates its own tables in the same database exactly as in production.

The factory service and ingress run as plain Node processes against those containers — not containerized themselves, because the thing being developed should be the thing being restarted.

#### 5. The rule the escape hatches follow

Each hosted dependency has exactly one substitute and one flag to use the real thing: execution (local ↔ Vercel Sandbox), webhooks (fixtures ↔ tunnel), models (fakes ↔ real keys), storage (MinIO ↔ Supabase Storage), database (docker Postgres ↔ Supabase). Substitutes sit behind seams that already exist or that Milestone 2 creates anyway; **no substitute may be a second implementation of factory logic.** A fake worker replays events, it does not decide anything.

### Consequences

- A fresh clone runs the full loop offline with `docker compose up` plus a trigger command — no cloud account, no keys, no cost — which is what makes the loop approachable to develop against at all.
- Determinism by default means local failures are reproducible failures, and the same fixtures serve tests and dev.
- The gap between local and production is explicit and enumerated (isolation, credentials, network policy, real model behavior) rather than discovered in staging. The flag list *is* the list of things local mode cannot prove.
- Fixtures drift from GitHub's real payloads over time; the tunnel path is how they get refreshed, and a fixture that has never been re-captured is a quiet liability.
- The fake worker adapter is new code to maintain alongside the real one (ADR-0006), justified by the alternative — every local iteration costing a real Codex session.
- Nothing here constrains production: every substitute lives behind a seam that exists for other reasons, so no ADR is weakened to make local development pleasant.
