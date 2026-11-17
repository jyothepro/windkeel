-- What the agent did, step by step, on the run's feed (gap G1, docs/ui/console-ux.md).
--
-- Until now a turn's normalized events (src/worker/adapter.ts `WorkerEvent`) were folded into
-- `AgentSessionSummary` and never kept one by one, so the feed carried state changes and cost and
-- nothing a person could watch the agent do. This table keeps the steps.
--
-- **Not a transcript of tokens.** ADR-0013 §1 keeps per-token detail out of Postgres, and that
-- still holds: a `WorkerEvent` is already one step (a command, a test, a file changed, one
-- reasoning item, one message), never a delta, and every text field is capped at write time
-- (src/factory/agent-events.ts). A two-hour session is hundreds of rows, not thousands.
--
-- **On the feed's cursor.** `seq` comes from `run_event_seq`, the sequence the transition log and
-- the cost ledger already share (0017), so one scalar cursor still orders all three. The write
-- path holds the `engineering_run` row lock before it takes a value, as both other writers do —
-- that is what keeps sequence order equal to commit order within one run.
--
-- **Idempotent by `(agent_run_id, ordinal)`.** `ordinal` is the event's position in its agent
-- run, counted from the durable summary a poll starts from. A redelivered poll re-reads from the
-- same watermark and the same summary, so it computes the same ordinals and inserts nothing new.
create table agent_event (
  id                  uuid primary key default gen_random_uuid(),
  engineering_run_id  uuid not null references engineering_run (id),
  agent_run_id        uuid not null references agent_run (id),
  ordinal             integer not null check (ordinal >= 0),
  seq                 bigint not null default nextval('run_event_seq'),
  at                  timestamptz not null default now(),
  type                text not null check (type in (
                        'started', 'thinking', 'command_started', 'command_finished',
                        'test_started', 'test_finished', 'file_changed', 'message',
                        'completed', 'failed'
                      )),
  -- The event minus its `type`, capped. Shape per type is `WorkerEvent`'s.
  payload             jsonb not null default '{}'::jsonb,
  unique (agent_run_id, ordinal)
);

create unique index agent_event_seq_idx on agent_event (seq);
create index agent_event_feed_idx on agent_event (engineering_run_id, seq);
