-- Maker-session recovery (#340 issue B): the two pieces of state the recovery fixes need.
--
-- 1. `agent_session_progress.turn_ended_at` — the turn has ended but its completion is not yet
--    recorded on the `AgentRun`. The progress row used to be deleted the moment a turn ended,
--    which left a window (row gone, `completed_at` not yet written) in which a redelivery saw
--    "no turn in flight, none completed" and launched a *second* agent into a checkout that
--    already held the first one's edits. The row now survives until the caller records
--    completion, marked ended, so a redelivery reuses the finished turn instead of re-running it.
--
-- 2. `workflow_run_binding.execution_token` / `reclaim_count` / `reclaimed_at` — the stalled-run
--    sweep (`src/factory/sweeps/stalled-runs.ts`). A binding stuck at `running` because its step
--    died without being redelivered is re-dispatched to a *new* execution; the token fences the
--    old one, so if it ever wakes it finds it no longer owns the run and stops without writing.
--    Null on every binding written before this migration, which is what those executions pass.
--    `reclaim_count` bounds re-dispatch: past the limit the run is failed by name instead.
--
-- Idempotent and cheap: nullable columns and a defaulted integer (no table rewrite on Postgres
-- 11+), and a small partial index over the only phases the sweep selects — every phase but
-- `finished`, including `waiting`: a live parked execution re-ticks every 300 s, so a stale
-- `waiting` binding is a dead execution too.
--
-- **No object here is schema-qualified** (ADR-0024 §11).

alter table agent_session_progress
  add column if not exists turn_ended_at timestamptz;

alter table workflow_run_binding
  add column if not exists execution_token uuid,
  add column if not exists reclaim_count integer not null default 0,
  add column if not exists reclaimed_at timestamptz;

create index if not exists workflow_run_binding_stalled_idx
  on workflow_run_binding (updated_at)
  where phase in ('queued', 'running', 'retrying', 'waiting');
