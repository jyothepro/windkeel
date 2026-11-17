-- Which worker session a run holds, in a form a different process can pick up (#210).
--
-- ADR-0011 §2 requires a repair attempt to resume **the same** worker session the maker used.
-- That was held in `WorkerSessionRegistry`, an in-process Map, which was correct while one
-- long-lived container carried a whole run: IMPLEMENTING, VERIFYING and REPAIRING were three
-- deliveries to the same process.
--
-- ADR-0020's topology removes that guarantee. A stage is a separate invocation, so the registry
-- is a same-process cache and REPAIRING routinely runs somewhere that never held the session.
-- #196 made a session re-acquirable as a `WorkerSessionRef`; #197 persisted one, but in
-- `agent_session_progress`, which is deleted when a turn ends — so by REPAIRING there was
-- nothing left to attach to and every repair turn failed with `session_unreachable`.
--
-- This is that missing half, and it is deliberately shaped like `workflow_run_binding`
-- (migrations/0011): **transport, never truth** (ADR-0007 §1). No run state, no verdict, no
-- cost — only "which session this run holds, and what can be done with it".
--
-- Keyed by the engineering run because that is what a session belongs to. ADR-0011 §2 says a run
-- has exactly one worker session across every turn it takes — the repairer *is* the implementer,
-- resumed — so a key that could hold two would model something the policy forbids.
-- `WorkerSessionRegistry` is keyed the same way, for the same stated reason.
create table worker_session_binding (
  engineering_run_id  uuid primary key references engineering_run (id),
  -- `WorkerAdapter.name` at start(). A different adapter must refuse to attach (ADR-0011 §2
  -- forbids changing the worker between attempts), and the refusal needs to name what it found.
  worker_type         text not null,
  -- `WorkerSessionRef` (src/worker/adapter.ts): adapter-private, JSON-serialisable, no live
  -- object. Rewritten as the turn advances, because the adapter's own bookkeeping — for Codex,
  -- the scratch path, the current turn and the output watermark — moves with it.
  session_ref         jsonb not null,
  -- `WorkerAdapter.capabilities.resumableSessions` as observed at start(), so a later process
  -- can answer "may this be resumed" without holding the adapter that started it.
  resumable           boolean not null,
  started_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
