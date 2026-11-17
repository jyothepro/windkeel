-- Which durable execution carries an engineering run, and what phase it is in.
--
-- pg-boss owned a queryable `job` table in its own schema, and `PgBossWorkflowProvider` read it
-- for two things: exactly-once `startRun` (via `singletonKey`) and `RunStatus.inFlight`. Vercel
-- Workflow owns its journal and exposes no table we can query alongside a run row, so a
-- provider backed by it has to record that liveness somewhere.
--
-- This is that somewhere, and it is deliberately **transport, never truth** (ADR-0007 §1). Every
-- column below answers "which machinery is carrying this run, and is it moving" — the exact
-- delta `RunStatus` documents. No run state, no verdict, no cost: `engineering_run` remains the
-- single authority, and `test/postgres-authoritative.test.js` fails if that stops being true.
--
-- The primary key is the *engineering* run id, not the workflow run id. That is the whole
-- serialisation mechanism: it makes "one durable execution per run" a database invariant rather
-- than a queue policy, replacing pg-boss's `policy: "singleton"` + per-run `singletonKey` with
-- something stronger — a unique index cannot be misconfigured, and it holds across deployments,
-- regions and SDK versions.
create table workflow_run_binding (
  engineering_run_id  uuid primary key references engineering_run (id),
  -- The backing that owns the execution ("vercel-workflow"). Recorded rather than assumed, so
  -- an operator reading a stuck run can tell which machinery is supposed to be carrying it, and
  -- so #199's side-by-side period is legible in SQL.
  provider            text not null,
  -- The provider's own identifier for the durable execution (a Vercel Workflow `wrun_…` id).
  -- Opaque here on purpose: nothing outside src/factory/workflow/vercel.ts parses it.
  execution_handle    text not null,
  -- Where the stage loop is, as the loop itself last reported. `running` means a handler holds
  -- the run; `waiting` means it is parked on an external signal; `retrying` means a handler
  -- threw and the loop is about to redeliver; `finished` means the execution returned.
  phase               text not null default 'queued'
                        check (phase in ('queued', 'running', 'waiting', 'retrying', 'finished')),
  -- 1-based, and reset to 1 whenever a stage completes. This is `StageContext.attempt`, and it
  -- lives here rather than only in the workflow journal so `retriesFailedStages` survives the
  -- execution being resumed by a different process.
  attempt             integer not null default 1 check (attempt >= 1),
  started_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index workflow_run_binding_phase_idx on workflow_run_binding (phase);
