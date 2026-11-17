-- Batches: one ask fanned out into many independently verified runs (#391, ADR-0036).
--
-- A batch is grouping, scheduling and a roll-up — nothing else. Every child is an ordinary
-- engineering task with its own run, rails, verification and evidence; nothing here can gate,
-- approve, merge or mark a child ready (ADR-0004, ADR-0029).
--
-- **Children are materialised lazily.** A `batch_item` is a row, not a run, until the dispatcher
-- (`src/batches/dispatch.ts`) has a free slot for it. Only then is a task and its run created,
-- through the same intake path every other source uses (`createTaskFromIntake` →
-- `createTaskAndRun`, source `batch`, reference `batch:{batchId}:{ordinal}`), so the run is
-- capped by ADR-0011's rails and the unique (organization, source, reference) index of
-- migrations/0023 makes a retried dispatch find the task it already made. A held item is never a
-- `CREATED` run, so the stranded-created-runs sweep cannot resurrect it, and no run state is
-- added (ADR-0003 unchanged).
--
-- `batch.status` stores lifecycle and outcome only. Progress (counts by child state, verdicts,
-- the summed cost of the child runs) is derived on read, never denormalised.
--
-- **No object here is schema-qualified** (ADR-0024 §11).

create table batch (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references organization (id),
  kind                     text not null check (kind in ('fanout', 'multi_repo')),
  title                    text not null,
  description              text not null,
  -- The child template: `riskLevel`, `criteria`, `spendCapUsd`, `wallClockCapSeconds`.
  template                 jsonb not null default '{}'::jsonb,
  max_concurrency          int not null default 3 check (max_concurrency between 1 and 50),
  -- Null only when the creator confirmed an uncapped batch out loud (ADR-0011 §3's rule, applied
  -- to the batch as a whole).
  batch_spend_cap_usd      numeric check (batch_spend_cap_usd is null or batch_spend_cap_usd > 0),
  stop_on_failure_ratio    numeric check (stop_on_failure_ratio is null or (stop_on_failure_ratio > 0 and stop_on_failure_ratio <= 1)),
  status                   text not null default 'RUNNING'
                             check (status in ('RUNNING', 'PAUSED', 'STOPPING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED')),
  stop_reason              text check (stop_reason in ('batch_spend_cap', 'failure_ratio', 'cancelled')),
  created_by_principal_id  uuid references principal (id),
  completed_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index batch_organization_id_idx on batch (organization_id, created_at desc, id desc);
-- The dispatcher's query: batches that may still start or settle children.
create index batch_live_idx on batch (organization_id) where status in ('RUNNING', 'STOPPING');

create table batch_item (
  id             uuid primary key default gen_random_uuid(),
  batch_id       uuid not null references batch (id) on delete cascade,
  ordinal        int not null check (ordinal >= 0),
  repository_id  uuid not null references repository (id),
  -- Set when the item is materialised.
  task_id        uuid references engineering_task (id),
  run_id         uuid references engineering_run (id),
  state          text not null default 'pending' check (state in ('pending', 'dispatched', 'skipped')),
  -- Why an item was skipped: `repository_not_granted`, `batch_cancelled`, `batch_stopped`.
  skip_reason    text,
  -- The child's own title/description/criteria, over the batch's.
  spec           jsonb not null,
  dispatched_at  timestamptz,
  unique (batch_id, ordinal)
);
create index batch_item_pending_idx on batch_item (batch_id, ordinal) where state = 'pending';
create index batch_item_run_id_idx on batch_item (run_id) where run_id is not null;

-- The batch a task was materialised for, for audit and for `GET /v1/runs?batch=`.
alter table engineering_task add column batch_id uuid references batch (id);
create index engineering_task_batch_id_idx on engineering_task (batch_id) where batch_id is not null;

-- The organization-wide ceiling on runs doing work at once, across every batch. Null means the
-- deployment default (`ORQON_DEFAULT_ORG_MAX_CONCURRENT_RUNS`, 10).
alter table organization
  add column max_concurrent_runs int check (max_concurrent_runs is null or max_concurrent_runs > 0);

-- Creating, pausing, resuming and cancelling batches. Admin only, as `schedules.manage` is: a
-- batch starts many runs that spend money.
update access_role set permissions = permissions || array['batches.manage'], updated_at = now()
 where key = 'admin' and account_id is null and not ('batches.manage' = any (permissions));
