-- Milestone 4 (ADR-0007): the two durable facts the WorkflowProvider needs that are not run
-- state. Neither is a second state store — ADR-0007 explicitly rejected one — and neither is
-- ever read as the answer to "what state is this run in". The `engineering_run` row remains
-- the single authority; these are intent and transport.
--
-- pg-boss's own tables are deliberately NOT created here. It installs and migrates its own
-- schema (default `pgboss`, overridable) through its own versioned migration machinery, and
-- letting it own that is the point: a hand-written copy in this repo would pin us to one
-- pg-boss version's internal layout and break on its next upgrade. Keeping it in a separate
-- Postgres schema also makes the ADR-0007 boundary physically visible — `orqon` tables are
-- truth, `pgboss` tables are transport — and lets a `pg_dump -n public` of the factory's
-- state come back without a queue's worth of dead jobs attached.

-- An external event delivered to a run (ADR-0007 §2: "signal and cancel are data"). Ingress
-- persists one of these and returns; the handler that cares consumes it later. Consumption is
-- recorded rather than deleting the row, so an approval is auditable after the fact and a
-- redelivered job cannot re-apply one.
create table run_signal (
  id                 uuid primary key default gen_random_uuid(),
  engineering_run_id uuid not null references engineering_run (id) on delete cascade,
  kind               text not null,
  payload            jsonb not null default '{}'::jsonb,
  received_at        timestamptz not null default now(),
  consumed_at        timestamptz,
  -- Which delivery consumed it: an audit breadcrumb for the at-least-once case.
  consumed_by_job    text
);

-- The pending-signal read is the hot one (every stage delivery calls takeSignals).
create index run_signal_pending_idx
  on run_signal (engineering_run_id, received_at)
  where consumed_at is null;

-- Cancellation is a *latched* intent, not a signal: a signal is consumed by the first handler
-- that reads it, and a cancellation that could be consumed would stop applying to the stages
-- after it. One row per run, set once, read by every subsequent cooperative check — which is
-- what makes `StageContext.isCancellationRequested()` honest across a whole run rather than
-- for one stage.
create table run_cancellation (
  engineering_run_id uuid primary key references engineering_run (id) on delete cascade,
  reason             text,
  requested_by       text,
  requested_at       timestamptz not null default now()
);
