-- Where an agent session's accumulating summary lives between polls (#197).
--
-- `consumeSession` used to build `AgentSessionSummary` in a local variable while it blocked on
-- the worker's event stream. Restructured into sleep-and-poll, each poll may be a different
-- process, so the accumulator needs somewhere durable. Postgres is the source of truth
-- (ADR-0007 §1) and inventing a second one is exactly what that decision forbids.
--
-- **This is not run state.** The `EngineeringRun` row remains the single authority for where a
-- run is; nothing here answers that question, and `test/postgres-authoritative.test.js` fails if
-- it starts to. What is here is the in-flight bookkeeping of one agent turn: the partial summary,
-- the reference that re-acquires the session (#196), and the output watermark.
--
-- Keyed by `agent_run_id` rather than by engineering run: a run has several agent runs (the
-- maker's turn, then each repair turn), each with its own summary, and `AgentRun.result` is
-- where each one's *final* summary lands. This table holds the same shape while it is still
-- being built, and is deleted when the turn completes — it is scaffolding, not a second record.
create table agent_session_progress (
  agent_run_id        uuid primary key references agent_run (id),
  engineering_run_id  uuid not null references engineering_run (id),
  -- The `AgentSessionSummary` so far. Same shape the completed turn writes to
  -- `AgentRun.result`, so there is one summary format rather than two that can drift.
  summary             jsonb not null,
  -- `WorkerSessionRef` (src/worker/adapter.ts): adapter-private, serialisable, no live object.
  -- Null when the adapter cannot produce one (`reattachableSessions: false`), which is how a
  -- poll in a *different* process knows it cannot continue rather than discovering it midway.
  session_ref         jsonb,
  -- Polls taken. Recorded because #197's step-ceiling argument is arithmetic about this number,
  -- and an argument nothing can read back is a comment.
  polls               integer not null default 0 check (polls >= 0),
  started_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index agent_session_progress_run_idx on agent_session_progress (engineering_run_id);
