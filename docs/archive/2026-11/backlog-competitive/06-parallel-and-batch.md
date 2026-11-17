# Parallel and batch work: child runs, concurrent sessions, and cross-repo batch changes with aggregate status

> ADR and migration numbers below are placeholders: use the next free number in `docs/adr/` and `migrations/` when implementing.

## Why

Devin ("MultiDevin"/parallel sessions) and Factory.ai (Droids fanned out across repos for migrations) both sell *throughput*: one ask turns into many agents working at once, plus a roll-up view. Windkeel today runs one task → one run → one PR. To compete we need fan-out — **but Windkeel's edge is the independent verifier** (ADR-0004: verification in a fresh, independent sandbox) and ADR-0029's rule that the verifier stays the gate: **there is no path around verification**. Fan-out must therefore multiply *verified* runs, never introduce a "batch merge" or aggregate pass that skips per-run verification. Every child is a normal `EngineeringRun` with its own verification, rails and evidence; the batch is only a grouping + scheduler + roll-up. And because N runs means N× spend, ADR-0011's rails must hold at the batch level too (a batch cap so "migrate 200 repos" cannot be an unbounded spend instrument).

## Background the implementer needs

Read before starting: `docs/adr/0003-*`, `0004-*`, `0011-*`, `0016-*`, `0018-*`, `0020-*`, `0021-*`, `0023-*`, `0024-*`, `0029-*`; `docs/control-plane-api.md`; `docs/schedules.md`; `docs/sweeps.md`; `research/MILESTONES.md`.

### ADRs (1-2 lines each)
- **ADR-0003** — domain model: `EngineeringTask` → many `EngineeringRun`s; run state machine (`src/factory/run-state-machine.ts`); "recovery is a new run". No new run states without an ADR amendment.
- **ADR-0004** — verification runs in a fresh independent sandbox; maker never grades itself.
- **ADR-0011** — rails: risk-tiered repair caps, `spend_cap_usd` (default $25, null only with explicit `uncappedConfirmed`), `wall_clock_cap_seconds` (default 7200), stuck detection, `stop_reason`. Implemented in `src/factory/rails.ts` (`runRails`, `checkCaps`, `RunRails`, `UncappedRunError`) and `src/factory/rails-gate.ts` (`enforceSpendAndTimeRails`, `enforceRepairLoopRails`).
- **ADR-0016** — local development is hermetic by default: no network/real cloud in `npm test`; real services only behind explicit env.
- **ADR-0018** — repository is an entity resolved per task (`src/factory/repository-entity.ts`). A batch over many repos = many tasks, one repo each.
- **ADR-0020/0021** — control plane is Vercel end-to-end; `WorkflowProvider` (`src/factory/workflow/provider.ts`) is backed by Vercel Workflow (`src/factory/workflow/vercel.ts`, fake in `fake.ts`). Steps are capped at 800 s; long work re-queues.
- **ADR-0023** — API reads direct, writes are intents; updates resume from a cursor (`/v1/events`).
- **ADR-0024** — tenancy: account/organization/principal; permissions are strings on `access_role` (`migrations/0021_tenancy.sql`, `0024_service_principal.sql` shows how a permission is added). Automations act as an org system actor, never as a person.
- **ADR-0029** — integrated assistant; verifier stays the gate; amends ADR-0011 §2 (human cycles cap).

### Current code seams (real)
- Task + run creation: `src/factory/task-creation.ts` — `createTaskAndRun(db, spec: TaskSpec)`, `startNewRun(db, taskId, options)`. Rails are applied *here* so no intake can bypass caps. Batch children MUST go through this.
- Rows: `src/factory/repositories.ts` (`insertEngineeringTask`, `insertEngineeringRun`, `getEngineeringRun`, …). Schema: `migrations/0001_factory_schema.sql` (`engineering_task`, `engineering_run`).
- Starting execution: ingress `runEnqueuer` / `windkeelActions` in `apps/ingress/src/windkeel-actions.ts`; `startRun` is idempotent and writes `workflow_run_binding` (`migrations/0011_workflow_run_binding.sql`). The stranded-created-runs sweep (`src/factory/sweeps/stranded-created-runs.ts`) re-enqueues CREATED runs with no binding after 10 min — **a deliberately held (queued-by-batch) child must not be resurrected by it** (see Design).
- Sweeps / cron: `docs/sweeps.md`, `apps/ingress/api/sweep.ts`, `apps/ingress/src/cron-route.ts`, advisory lock helper `src/factory/sweeps/advisory-lock.ts`.
- Closest analogue to copy: **schedules** — `migrations/0026_schedule.sql`, `src/schedules/{store,tick,cron}.ts`, API `apps/ingress/src/api/schedules.ts`, CLI `packages/cli/src/commands/schedule.ts`, tests `test/api-schedules.test.js`, `test/schedules-tick.test.js`. Schedules create tasks through the intake pipeline (`src/intake/pipeline.ts`, `runIntake`) as a system actor with idempotency keys in `intake_delivery`.
- API routing table: `apps/ingress/src/api/route.ts` (e.g. `{ method: "POST", pattern: "/v1/tasks", name: "createTask", ...WRITE }`), handlers in `apps/ingress/src/api/handlers.ts`, router `router.ts`. Reads in `src/factory/api-queries.ts`.
- Console: Next.js app `apps/console/app/(console)/{runs,tasks,repositories,metrics}`; `tasks/new` is the task composer.
- Cost: `src/factory/cost-ledger.ts`, `engineering_run.cost` maintained sum of `cost_event`.

### Test conventions
- `node --test` over `test/*.test.js`, importing from `dist/` (`npm test` builds first). Postgres tests skip unless `TEST_DATABASE_URL` is set (`const skip = dbUrl ? false : "TEST_DATABASE_URL not set"`); run migrations with `runMigrations` from `dist/factory/migrate.js`; helpers in `test/helpers.js` (`seedFixtureRepository`, `TEST_POOL`, `bareFixtureRepo`, `tempDir`).
- Fakes: `FakeSandboxProvider` (`dist/sandbox/fake.js`), `FakeGitHubClient` (`dist/github/fake.js`), `ScriptedWorkerAdapter` (`dist/worker/scripted.js`), `FakeWorkflowProvider` (`src/factory/workflow/fake.ts`); full stack via `test/factory-stack.js` (`startFactory`) and `test/workflow-runtime.js` (`runtimeSkip`, `untilAsleep`, `endExecutions`). End-to-end pattern: `test/e2e-github-loop.test.js`. API pattern: `test/api-schedules.test.js` (`handleApiRequest` + `WindkeelApi` CLI client). Browser: `test/console-browser.js` helpers, e.g. `test/console-models-browser.test.js`.
- `test/adr.test.js` checks ADR files' shape — a new ADR must pass it. `test/migrate.test.js` checks migrations.

## Scope

### In
1. **Batch entity** grouping N child tasks/runs, with an aggregate status and roll-up cost.
2. **Batch kinds**: (a) `fanout` — one ask split into explicit child sub-tasks on one repo (sub-task list supplied by the caller or by a planner step; v1: caller-supplied, optional model-proposed split behind approval); (b) `multi_repo` — the same change (title/description/criteria template) applied to a list of repositories (migrations).
3. **Concurrency scheduler**: per-batch `max_concurrency` and an org-wide `max_concurrent_runs` limit; children wait in a held state until a slot frees.
4. **Batch rails**: `batch_spend_cap_usd` (required by default, like ADR-0011), per-child rails still enforced by `runRails`, and a `stop_on_failure_ratio` circuit breaker.
5. API `/v1/batches…`, CLI `windkeel batch …`, console list + detail page with aggregate status.
6. ADR documenting the decision (new ADR-0030).

### Out of scope
- Any aggregate verdict that replaces per-run verification; any batch merge / auto-merge.
- Cross-child shared workspaces or children depending on each other's diffs (DAGs). v1 children are independent; ordering only.
- Environment snapshots for faster fan-out (item 02-environment-snapshots).
- Intake from Slack/Linear/Jira creating batches (04 can add later).
- Billing for batches (09).

## Design

### Data model — new file `migrations/0037_batch.sql` (next number after `0036_run_merge_claim.sql`; re-check `ls migrations` before naming)
```sql
create table batch (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references organization (id),
  kind                      text not null check (kind in ('fanout', 'multi_repo')),
  title                     text not null,
  description               text not null,
  -- template for multi_repo: criteria jsonb, risk_level
  template                  jsonb not null default '{}'::jsonb,
  max_concurrency           int not null default 3 check (max_concurrency between 1 and 50),
  batch_spend_cap_usd       numeric check (batch_spend_cap_usd is null or batch_spend_cap_usd > 0),
  stop_on_failure_ratio     numeric check (stop_on_failure_ratio is null or (stop_on_failure_ratio > 0 and stop_on_failure_ratio <= 1)),
  status                    text not null default 'RUNNING' check (status in ('RUNNING','PAUSED','STOPPING','COMPLETED','PARTIAL','FAILED','CANCELLED')),
  stop_reason               text check (stop_reason in ('batch_spend_cap','failure_ratio','cancelled')),
  created_by_principal_id   uuid references principal (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table batch_item (
  id              uuid primary key default gen_random_uuid(),
  batch_id        uuid not null references batch (id),
  ordinal         int not null,
  repository_id   uuid not null references repository (id),
  task_id         uuid references engineering_task (id),   -- set when materialized
  run_id          uuid references engineering_run (id),    -- current run
  state           text not null default 'pending' check (state in ('pending','dispatched','skipped')),
  spec            jsonb not null,  -- child title/description/criteria overrides
  unique (batch_id, ordinal)
);
create index batch_item_pending_idx on batch_item (batch_id, ordinal) where state = 'pending';
alter table engineering_task add column batch_id uuid references batch (id);
-- permission
update access_role set permissions = permissions || array['batches.manage'], updated_at = now()
 where key = 'admin' and account_id is null and not ('batches.manage' = any (permissions));
```
Plus `org_settings`-style limit: if no org-settings table exists, add `organization.max_concurrent_runs int not null default 10` in the same migration (check `migrations/0021_tenancy.sql` for the organization table first). No object schema-qualified (ADR-0024 §11 convention, see header of `0026_schedule.sql`).

**Key decision:** children are *not* created as runs up front. `batch_item` rows are `pending`; the dispatcher materializes a child (task + run via `createTaskAndRun`, `sourceType: "batch"`, `sourceReference: "batch:{batchId}:{ordinal}"`) only when a slot is free. This avoids new run states (ADR-0003 untouched) and avoids the stranded-created-runs sweep resurrecting held runs.

Aggregate status is **derived** (view or query in `src/factory/api-queries.ts`), not denormalized: counts by child run status, sum of child `engineering_run.cost`, verdict counts. `batch.status` stores only lifecycle (RUNNING/PAUSED/STOPPING/…) and terminal outcome: `COMPLETED` all children COMPLETED/PR_READY with pass; `PARTIAL` mixed; `FAILED` all failed; set when no pending items and no non-terminal child runs.

### Dispatcher — new file `src/batches/dispatch.ts` (+ `src/batches/store.ts`)
`dispatchBatches(pool, deps, now)`:
1. Under advisory lock `batches` (`src/factory/sweeps/advisory-lock.ts`).
2. For each RUNNING batch: active = children non-terminal; org active = org's non-terminal runs. Free = min(max_concurrency − active, org.max_concurrent_runs − orgActive).
3. Before dispatching: compute batch spend = sum child cost. If `batch_spend_cap_usd` not null and spend ≥ cap → status STOPPING, stop_reason `batch_spend_cap`, no new dispatch (in-flight runs finish under their own rails; optional: cancel them — default **let them finish**, see Risks). Failure ratio: terminal-failed / terminal ≥ ratio after ≥3 terminal children → STOPPING `failure_ratio`.
4. Per-child spend cap = min(template cap or default $25, remaining batch budget) — passed into `createTaskAndRun` `rails` so ADR-0011 `checkCaps` enforces it naturally. Remaining budget ≤ 0 → don't dispatch.
5. Claim pending items `for update skip locked`, create task+run in the same transaction, mark `dispatched`, then after commit enqueue via the existing run enqueuer (same as intake `AfterCommit`).
6. Idempotent: `intake_delivery`-style key or unique `(source_type, source_reference)` on task prevents double-create on retries.

Triggers: called (a) right after batch create, (b) on every run terminal transition for a run whose task has `batch_id` (hook into where terminal transitions are recorded — find via `run-state-machine.ts` / `run-service.ts advanceRun`; do it as an after-commit best-effort call), (c) a cron safety net: new route reuse — add a `batches` job to the five-minute `/api/schedules` cron or a new `apps/ingress/api/batches.ts` with `CRON_SECRET` (copy `apps/ingress/src/cron-route.ts`).

### Fanout splitting
v1: caller passes `items: [{title, description, criteria}]`. Optional `split: "propose"` creates the batch PAUSED with a model-proposed item list (use the existing task-understanding model path, ADR-0012) that a person must approve (`POST /v1/batches/:id/resume`). Default: implement caller-supplied only in sub-task A; propose in sub-task D (optional).

### Repo targeting for multi_repo
`repositories: [repositoryId…]` or `repository_query` (v1: explicit ids only). Each must be granted to the org (reuse `src/factory/workflow/repository-grant-gate.ts` semantics / grants table); refuse 422 listing ungranted repos. Max 200 items per batch (env `WINDKEEL_BATCH_MAX_ITEMS`, default 200).

### API (add to `apps/ingress/src/api/route.ts`)
- `POST /v1/batches` (permission `batches.manage`, `command: true`, idempotency key like other writes — see `src/intake/idempotency.ts`): body `{kind, title, description, items? , repositories?, template?, max_concurrency?, batch_spend_cap_usd?, uncapped_confirmed?, stop_on_failure_ratio?, risk_level?}`. Null batch cap without `uncapped_confirmed: true` → 422 (mirror `UncappedRunError`).
- `GET /v1/batches`, `GET /v1/batches/:batchId` (aggregate: counts per status, verdicts, total cost, remaining budget, items with run ids/PR urls) — `runs.read`.
- `POST /v1/batches/:batchId/pause|resume|cancel` — `batches.manage`. Cancel = stop dispatch + cancel non-terminal children via existing `cancelRun` path.
- `GET /v1/runs?batch_id=` filter.
- Document in `docs/control-plane-api.md`.

### CLI — new file `packages/cli/src/commands/batch.ts`
`windkeel batch create --repos a,b,c --title … --description … --criteria-file … --max-concurrency 5 --cap 100`, `windkeel batch create --items items.json`, `windkeel batch status <id> [--watch]`, `pause|resume|cancel`. Copy `schedule.ts` (`capFlag`).

### Console
- `apps/console/app/(console)/batches/page.tsx` (list) and `batches/[id]/page.tsx` (detail): progress bar by status, verdict counts, spend vs cap, per-item table linking to `/runs/[id]` and PRs, pause/resume/cancel buttons (only with permission). Nav entry. Run detail shows "Part of batch X". No "merge all" button.

### Config/env
`WINDKEEL_BATCH_MAX_ITEMS` (200), `WINDKEEL_DEFAULT_ORG_MAX_CONCURRENT_RUNS` (10) only as fallback. Document in deployable env contract (`test/deployable-env-contract.test.js` checks env lists — update accordingly).

### Security
- Batch actions run as the creating principal for authorization at create time, but children are created with `createdByPrincipalId` = creator (it's a person's explicit request), not as system actor; record batch id on task for audit.
- Every child repo must pass grant checks individually at dispatch (a grant revoked mid-batch → item `skipped` with reason).
- Org concurrency limit protects sandbox quota and is the DoS/spend guard.
- Per-child verification, evidence, rails unchanged — no code path where batch status affects a child's verdict or PR readiness.

## Implementation steps

1. Write ADR `docs/adr/0030-batches-group-verified-runs-and-never-gate-them.md` (status Proposed): batches are grouping+scheduling only; batch spend cap required by default; children materialized lazily; no new run states. Run `npm test -- test/adr.test.js` equivalent (whole suite ok).
2. Add `migrations/0037_batch.sql`; `npm test` with `TEST_DATABASE_URL` → `test/migrate.test.js` green.
3. `src/batches/store.ts`: insert/get/list batch + items, aggregate query. Unit-test against Postgres.
4. `src/batches/rails.ts` (new): pure functions `batchFreeSlots`, `batchStopReason({spend, cap, terminal, failed, ratio})`, `childSpendCap(remaining, default)`, `batchRails({cap, uncappedConfirmed})` throwing `UncappedBatchError`. Pure unit tests.
5. `src/batches/dispatch.ts`: `dispatchBatches` as designed; uses `createTaskAndRun`.
6. Hook dispatcher after terminal child transitions (after-commit, best-effort, errors logged not thrown) + cron route.
7. API routes + handlers + `api-queries` aggregate; `GET /v1/runs?batch_id`.
8. CLI command + `WindkeelApi` client methods (`packages/cli/src/client/`).
9. Console list/detail pages + run-detail badge.
10. Docs: `docs/control-plane-api.md`, new `docs/batches.md`, `docs/sweeps.md` (if cron added), `research/MILESTONES.md` row.

### Sub-tasks (each one PR)
- **A — model + dispatcher + rails (steps 1–6).** Done: migration applies; dispatcher respects concurrency/caps; tests in `test/batch-rails.test.js`, `test/batch-store.test.js`, `test/batch-dispatch.test.js` green.
- **B — API + CLI (7–8).** Done: `test/api-batches.test.js` green; docs updated. Blocked by A.
- **C — console (9) + e2e.** Done: `test/console-batches-browser.test.js` and `test/e2e-batch-loop.test.js` green. Blocked by B.
- **D (optional) — model-proposed fanout split behind approval.** Done: `split: "propose"` creates PAUSED batch with proposed items; nothing dispatched until resume; test in `test/batch-split.test.js`.

## Done condition
- `migrations/0037_batch.sql` (or next free number) exists and applies cleanly from scratch and on top of existing schema.
- `POST /v1/batches` with 3 repos and `max_concurrency: 2` creates 1 batch, 3 items; exactly 2 child runs exist immediately; 3rd materializes only after one child is terminal.
- Org `max_concurrent_runs` caps dispatch across batches.
- Null batch cap without `uncapped_confirmed` → 422; per-child `spend_cap_usd` ≤ remaining batch budget; batch at/over cap dispatches nothing more and records `stop_reason = 'batch_spend_cap'`.
- Failure-ratio breaker stops dispatch with `stop_reason = 'failure_ratio'`.
- Every child run goes through normal verification (has a `verification_run` row before any PR) — asserted in e2e; no endpoint/merge path exists on batches.
- Aggregate endpoint returns correct counts, verdicts, summed cost equal to SUM of child `engineering_run.cost`.
- Pause/resume/cancel work; cancel cancels non-terminal children.
- Stranded-created-runs sweep never touches pending batch items (they aren't runs).
- CLI `windkeel batch create/status/pause/resume/cancel` works against the router.
- Console batches list + detail render with aggregate status; no merge-all control.
- ADR-0030 added, passes `test/adr.test.js`; docs updated.
- `npm test` green with and without `TEST_DATABASE_URL` (DB tests skip cleanly without it), hermetic (ADR-0016).

## How to verify the done condition
```bash
cd /home/user/windkeel
npm ci
docker compose up -d          # local Postgres per docker-compose.yml
export TEST_DATABASE_URL=postgres://...   # as used by existing tests (see test/helpers.js / README)
npm test                      # builds, runs all node --test files
node --test test/batch-rails.test.js test/batch-store.test.js test/batch-dispatch.test.js \
  test/api-batches.test.js test/e2e-batch-loop.test.js   # after npm run build
```
Proof: all listed files report `pass` with 0 `fail`; without `TEST_DATABASE_URL` DB-backed ones report `skip`. Browser test: run the way existing `test/console-models-browser.test.js` is run (check its header for env/browser prerequisites). Manual/live (optional, needs deployed stack per item 01-live-proof): create a 3-repo batch via `windkeel batch create` with cap $10, watch `windkeel batch status --watch`; confirm ≤ max_concurrency runs active and each PR has the Windkeel verification check run.

## Tests required

### Unit
- `test/batch-rails.test.js` (pure): free slots (batch limit, org limit, both, negative → 0); stop reason (spend == cap stops; spend < cap continues; null cap never stops on spend; ratio fires only after ≥3 terminal; ratio exactly at threshold fires; 0 failures never fires); `childSpendCap` = min(default, remaining), remaining ≤ 0 → null-dispatch; `batchRails(null)` throws `UncappedBatchError` unless confirmed.
- `test/batch-store.test.js` (Postgres): insert/get/list; ordinal uniqueness; aggregate counts with mixed child states; cost sum equals SUM(child cost); org isolation (other org can't read).
- `test/batch-dispatch.test.js` (Postgres + `FakeWorkflowProvider`/fake enqueuer): dispatches only up to concurrency; re-dispatch after child terminal; concurrent `dispatchBatches` calls don't double-create (run two in parallel, assert task count); enqueue failure after commit leaves run CREATED+bound-less and stranded sweep heals it (dispatched items only); revoked grant → item skipped; batch cap reached → STOPPING, no new tasks; paused batch dispatches nothing; terminal batch status computed correctly (COMPLETED/PARTIAL/FAILED); child rails are passed to `createTaskAndRun` (assert `engineering_run.spend_cap_usd`).
- `test/migrate.test.js`: extend if it enumerates migrations.

### Integration / e2e
- `test/api-batches.test.js` (pattern: `test/api-schedules.test.js`): create (fanout & multi_repo), 422s (no items, >max items, ungranted repo, uncapped w/o confirm, bad concurrency), permissions (viewer can read, can't create; `batches.manage` required), idempotency key replay, pause/resume/cancel, `GET /v1/runs?batch_id`, CLI round-trip via `WindkeelApi` + `batchCommand`.
- `test/e2e-batch-loop.test.js` (pattern: `test/e2e-github-loop.test.js` with `startFactory`, `FakeSandboxProvider`, `ScriptedWorkerAdapter`, `FakeGitHubClient`, real Postgres + workflow runtime, `runtimeSkip`): 3 seeded fixture repos (`seedFixtureRepository`), batch max_concurrency 2; scripted worker makes repo 2 fail verification beyond repair cap; assert: never >2 children active, each child has verification_run(s), 2 draft PRs + 1 MAX_REPAIR_ATTEMPTS_REACHED, batch ends `PARTIAL`, aggregate cost matches.
- Rails e2e: batch cap so small the first child hits it → no further dispatch, `stop_reason = 'batch_spend_cap'`.

### Browser
- `test/console-batches-browser.test.js` using `test/console-browser.js` helpers: list shows batch with progress; detail shows counts, spend/cap, item links to run pages; pause button hidden for viewer role; no "merge" control present.

## Risks & open questions
- **On batch cap hit: cancel in-flight children or let them finish?** Default: let them finish (each still capped by its own child cap ≤ remaining budget at dispatch, so total overshoot ≤ in-flight caps). Human decision if strict.
- **Default `max_concurrency` 3 and org `max_concurrent_runs` 10** — tied to Vercel Sandbox quota; human to confirm.
- **Hooking terminal transitions**: if no clean after-terminal hook exists, rely on cron (≤5 min latency) for v1 and note it. Default: implement both, hook best-effort.
- **Fanout split by model** — needs approval UX; kept optional (D).
- Migration number may collide with other backlog items (02, 03, 08, 09 also add migrations) — take the next free number at implementation time.
- Should children of a multi_repo batch open PRs as one GitHub "batch" label? Default: add label/marker `windkeel-batch:{id}` in PR body only.
- ADR-0030 is Proposed; a human must accept it before merge of A.

## Suggested labels and dependencies
- Labels: `ready-for-agent` (sub-tasks A, B, C), `ready-for-human` for accepting ADR-0030 and the open defaults above; D `ready-for-agent` after A.
- Blocked-by: none hard. Soft: `01-live-proof` (live verification of concurrent sandboxes), `02-environment-snapshots` (makes fan-out cheap/fast), `08-enterprise-readiness` (org-level quotas/audit may subsume `max_concurrent_runs`), `09-billing-onboarding` (batch spend surfaced in billing). `05-agent-types-playbooks` playbooks can later be a batch template.
