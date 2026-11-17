# Windkeel — context

Windkeel turns a described piece of engineering work into a **verified draft pull request**. A maker
agent writes the change; an independent verifier, in a fresh sandbox, decides whether it passes.
This page is the one file to read first. Decisions and their reasoning: [docs/adr/](docs/adr/README.md).
Mechanical rules: `npm run arch:check`, `npm run invariant:check`.

## Glossary

- **Task** (`EngineeringTask`) — requested work: title, description, acceptance **criteria**
  (`Criterion[]`), risk level, one repository, one organization. Created by intake (ADR-0003, ADR-0018, ADR-0024 §3).
- **Run** (`EngineeringRun`) — one attempt at a task, driven through the run state machine
  (`CLASSIFYING … IMPLEMENTING → VERIFYING → PR_CREATING → WAITING_FOR_HUMAN`). A task can have many
  runs; at most one is live. Recovery is a new run (ADR-0003).
- **Stage** — one state's handler (`src/factory/workflow/handlers/*.ts`).
- **Maker** — the coding agent that edits the checkout in the maker sandbox. Untrusted, assumed hostile (ADR-0014).
- **Harness** — the maker program (Codex, Claude Code, OpenCode), chosen with the maker model and
  frozen per run (ADR-0006, ADR-0027).
- **Checker / verifier** — the verification engine (`@windkeel/verification`) running in its own
  sandbox, plus the checker model it uses for review. Produces the **verdict** `pass | warn | fail` (ADR-0004, ADR-0010).
- **Candidate** — the maker's commits at `candidate_sha`; the only thing the verifier takes from the maker.
- **Evidence package** — the verifier's sealed output (findings, criteria mapping, logs, `hashes.json`, DSSE envelope),
  stored in object storage, pointed to by `VerificationRun.evidence_package_ref`. Unsigned on the deployed path, and says so (ADR-0015, ADR-0022).
- **Repair loop** — `VERIFYING → REPAIRING → VERIFYING`; the maker gets the engine's `RepairPacket`. Capped by risk tier,
  plus spend, wall-clock and stuck rails (ADR-0011, ADR-0017).
- **Workspace** — a provisioned sandbox, `role: maker | verifier` (human workspaces: ADR-0029, proposed).
- **Environment snapshot** — a pre-maker, default-branch-only disk image used to warm sandboxes (ADR-0031).
- **Knowledge** — repository/organization notes and learned lessons injected into the maker's first prompt (ADR-0032).
- **Playbook** — an organization's versioned template for a kind of work: maker instructions, extra criteria,
  verifier requirements that can only strengthen (ADR-0033).
- **Batch** — a group of ordinary tasks (fan-out or multi-repo) paced under concurrency and spend limits; never a gate (ADR-0036).
- **Account → organization → principal** — tenancy. An account owns repositories and billing; organizations
  are granted repositories; a principal is a person, service or token holder acting in an organization (ADR-0024).
  **Role** = a set of permissions (built-in or account-defined, ADR-0030).
- **Intake** — every door work enters by (GitHub label/comment, API, Slack, Linear, Jira, Sentry, schedules);
  each ends in the same task-creation path (ADR-0009, ADR-0025).
- **Intent** — what an API write records: `202` plus a row the factory acts on, or a refusal (ADR-0023 §2).
- **Cost ledger** — append-only `cost_event` rows; the run's cost, budgets and billing all derive from it (ADR-0013, ADR-0037, ADR-0040).
- **Model snapshot** — a run's maker/checker models and credentials, frozen at intake (ADR-0026 §4).
- **Sweep** — an hourly cron job (retention, reaper, stalled runs, …) run from `/api/sweep` ([docs/sweeps.md](docs/sweeps.md)).
- **Audit event** — one row per act, per-account hash chain (ADR-0030).

### Avoid

- "PR check" or "CI" for verification — say **verification** / **verifier**.
- "Agent" alone where the side matters — say **maker** or **verifier**.
- "Job" for a run — a **run** is a factory attempt; a **sweep** is maintenance.
- "Tenant" — say **account** or **organization**.

## Invariants

These do not change without a new ADR.

1. **The verifier is the gate.** Nothing reaches a pull request without an independent verdict; nothing
   (permission, role, policy, batch, budget, playbook, env var) can skip or weaken verification (ADR-0004, ADR-0029 §7, ADR-0030 §9, ADR-0036, ADR-0037).
2. **Fresh sandbox per verification**, cloned from the remote at `base_sha` plus the candidate commits; no
   filesystem, dependency or environment state from the maker. Restored snapshots must predate any maker (ADR-0004, ADR-0031).
3. **Maker and checker are independent** by vendor and exact model; no independent checker ⇒ the run fails (ADR-0010, ADR-0026 §5).
4. **No model key enters a sandbox**; git tokens are per-role and minimal; egress narrows before agent or repo code runs; harness keys are reserved and never passed to candidate code, checked by `invariant:check` (ADR-0014).
5. **Postgres run rows are authoritative.** The workflow journal and queues are transport, never truth (ADR-0007 §1 → ADR-0021 §1).
6. **The run state machine is closed**: illegal transitions are rejected; terminal states are terminal; `warn` goes to a human, never to repair (ADR-0003).
7. **Ingress and factory meet through data**, never code; ingress never runs a stage — checked by `invariant:check` (ADR-0002 §3 → ADR-0020 §3).
8. **Every model call is recorded at a boundary Windkeel owns**, and every billable unit lands in `cost_event` (ADR-0013, ADR-0028).
9. **Tenancy is enforced in the store layer**: a row in another organization does not exist (ADR-0024 §8).
10. **Knowledge shapes the maker, never the verifier** — checked by `invariant:check` (ADR-0032).
11. **Playbooks only strengthen the verifier** — the merge lives in `@windkeel/verification`, checked by `invariant:check` (ADR-0033).
12. **The audit log is append-only and hash-chained** per account, written in the change's transaction; only `audit_event_purge` deletes — checked by `invariant:check` (ADR-0030).
13. **Windkeel never merges, approves or marks ready as the App**; a person merges as themselves, only the verified SHA — checked by `invariant:check` (ADR-0009, ADR-0023 §4, ADR-0029 §5).
14. **Maker output is never evidence** (screenshots, self-reports) (ADR-0035).
15. **`@windkeel/verification` has zero runtime dependencies** — checked by `invariant:check` (ADR-0005).
16. **Plaintext customer secrets** exist only inside the one handler call that uses them; stored sealed (ADR-0026 §3, ADR-0034).
17. **The factory core sits below its domains**: `src/factory` (except `workflow/`, `sweeps/`) never imports billing, intake, integrations, batches or schedules; it takes ports — checked by `arch:check` (ADR-0042).
18. **Every API response matches the contract**: each route has a schema in `@windkeel/api-contract`, enforced on every 2xx in the test suite — checked by `arch:check` (ADR-0042).

## System map

```
console (apps/console, Next.js) ─┐
CLI / MCP (packages/cli) ────────┼─▶ ingress API (apps/ingress: /v1, /webhook, /intake, /sweep)
GitHub / Slack / Linear / Jira ──┘           │ writes tasks, intents, signals (Postgres)
                                              ▼
                     factory (src/factory, via @windkeel/factory/* exports)
                     run state machine on Vercel Workflow (src/factory/workflow)
                                              │
                     sandboxes (src/sandbox, Vercel Sandbox): maker ── candidate commits ──▶ verifier
                                                                       (@windkeel/verification)
                     Postgres + object storage (Supabase, ADR-0008)
```

- **`packages/api-contract`** (`@windkeel/api-contract`) — the one API schema/view package shared by ingress, console and CLI.
- **`packages/verification`** (`@windkeel/verification`) — the engine: stages, evidence, verdict, providers, playbook merge.
- **`packages/cli`** — the published `windkeel` CLI and MCP server; an API client only.
- **`apps/ingress`** — the HTTP surface on Vercel; imports the factory only through `@windkeel/factory/*`
  (`src/public/*.ts`: batches, billing, execution, github, intake, integrations, models, ops, repositories, runs, sandbox, schedules, tenancy, workflow).
- **`apps/console`** — the web UI; server-side only holds tokens.
- **`src/`** — the factory (`factory/`, `sandbox/`, `worker/` harness adapters, `github/`, `intake/`, `integrations/`, `batches/`, `billing/`, `schedules/`).
- **`migrations/`** — forward-only SQL (ADR-0008). **`test/`** — `node:test` against `dist/`.
- **`scripts/arch-check.mjs`** — boundary rules (one API contract, public factory surface, module size, SQL behind stores).
  **`scripts/invariant-check.mjs`** — ADR invariants above.

Deeper: [docs/running-the-factory.md](docs/running-the-factory.md),
[docs/control-plane-api.md](docs/control-plane-api.md).
