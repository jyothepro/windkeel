-- Delivery state for operator guidance (ADR-0023 §8, as amended 2026-09-24).
--
-- `run_guidance` recorded that a person said something. It did not record whether the maker ever
-- heard it, because nothing delivered it: the API held an unwired `sendToMaker` port and refused
-- every message honestly. Ingress cannot deliver one — ADR-0002 §3 forbids it holding a step of a
-- run, and the maker session is a sandbox the worker container owns — so guidance is an *intent*
-- like every other write (ADR-0023 §2), and the worker drains it at a turn boundary.
--
-- A turn boundary is the only moment it can be delivered, and that is the adapter's constraint
-- rather than a choice: `WorkerAdapter.send()` starts a new turn, and `CodexWorkerAdapter.send`
-- refuses outright while one is running — "two concurrent codex processes mutating one workspace
-- is a corrupted attempt with no clean recovery". So the queue is real and its latency is one
-- poll interval plus the remainder of the current turn.
--
-- Three columns, and no status enum. The reported state is *derived* (see
-- `src/factory/run-guidance.ts`): a row with `delivered_at` was delivered, a row with
-- `undeliverable_reason` could not be, a row with neither is queued — or superseded, if the run
-- reached a terminal state before a turn boundary arrived. Deriving the last one means a run that
-- ends cannot leave a lying `status = 'queued'` behind, which a stored enum would require a hook
-- somewhere to prevent.
alter table run_guidance add column delivered_at timestamptz;
alter table run_guidance add column undeliverable_reason text;

-- How many times a delivery was attempted. Bumped when a row is claimed, not when it succeeds,
-- so a claim that then crashes is visible as an attempt rather than as a row nobody touched.
alter table run_guidance add column delivery_attempts integer not null default 0;

-- The claim query's index: pending rows for one run, in the order they were said.
create index run_guidance_pending_idx on run_guidance (engineering_run_id, seq)
  where delivered_at is null and undeliverable_reason is null;
