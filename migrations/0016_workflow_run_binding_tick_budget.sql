-- When an execution ended because it ran out of ticks rather than out of work (#261).
--
-- `orqonRunFlow` is a bounded loop, and its own comment calls reaching that bound "a bug, not a
-- state". Until now it was also invisible: the loop returned, the binding said `finished`, and
-- that is exactly what an orderly finish says. A run parked at WAITING_FOR_HUMAN for 6.9 days
-- fell off the end of its budget and nothing anywhere recorded that it had.
--
-- Still transport, never truth (ADR-0007 §1): this says something about the *machinery* that was
-- carrying the run — it stopped for a reason of its own — and nothing about where the run is.
-- The run row is untouched, and a run whose execution ran out of ticks is still exactly where
-- Postgres says it is.
--
-- Nullable, and null is the common case: it is set only by the loop's exhaustion step, and
-- cleared when `startRun` re-claims the binding, so it describes the execution the binding
-- currently names rather than the history of the run.
alter table workflow_run_binding
  add column tick_budget_exhausted_at timestamptz;

-- An operator's question is "which runs fell off their bound", and it is asked over the whole
-- table rather than for one run. Partial, because the answer is almost always a handful of rows.
create index workflow_run_binding_tick_budget_idx
  on workflow_run_binding (tick_budget_exhausted_at)
  where tick_budget_exhausted_at is not null;
