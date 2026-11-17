-- A resumable cursor for the run event feed, and a creation time for runs.
--
-- Both append-only tables (ADR-0013 §1 cost_event, §2 run_state_transition) key on a random
-- uuid and order by a `now()` timestamp. Neither can carry a feed cursor:
--
--   * `now()` is transaction-start time, so rows written in one transaction tie exactly;
--   * a random uuid breaks that tie in an order unrelated to when anything happened;
--   * and a client that advances a timestamp cursor past a transaction still in flight never
--     sees that transaction's rows once it commits. Silent loss, which for a watching client
--     reads as a run that stopped moving.
--
-- `seq` fixes the first two. The third is fixed by the write path rather than here: every
-- writer of either table holds the `engineering_run` row lock before it takes a sequence
-- value, so for a single run, sequence order is commit order. That is why the feed is
-- **per run**. A feed across runs has no such lock and would need a visibility watermark.
--
-- One sequence serves both tables so a cursor stays a single scalar: a client following a run
-- does not want to carry one cursor per event kind and merge them itself.

create sequence run_event_seq;

alter table run_state_transition add column seq bigint;
alter table cost_event add column seq bigint;

-- Backfill interleaved across both tables, oldest first, so history reads in the order it
-- happened rather than in the order the two tables are scanned.
with all_events as (
  select 'transition'::text as kind, id, at as ts from run_state_transition
  union all
  select 'cost'::text as kind, id, recorded_at as ts from cost_event
),
ordered as (
  select kind, id, row_number() over (order by ts, kind, id) as rn from all_events
)
update run_state_transition t set seq = o.rn
  from ordered o where o.kind = 'transition' and t.id = o.id;

with all_events as (
  select 'transition'::text as kind, id, at as ts from run_state_transition
  union all
  select 'cost'::text as kind, id, recorded_at as ts from cost_event
),
ordered as (
  select kind, id, row_number() over (order by ts, kind, id) as rn from all_events
)
update cost_event c set seq = o.rn
  from ordered o where o.kind = 'cost' and c.id = o.id;

select setval('run_event_seq', coalesce((select max(seq) from (
  select seq from run_state_transition union all select seq from cost_event
) s), 0) + 1, false);

alter table run_state_transition alter column seq set default nextval('run_event_seq');
alter table run_state_transition alter column seq set not null;
alter table cost_event alter column seq set default nextval('run_event_seq');
alter table cost_event alter column seq set not null;

create unique index run_state_transition_seq_idx on run_state_transition (seq);
create unique index cost_event_seq_idx on cost_event (seq);
create index run_state_transition_feed_idx on run_state_transition (engineering_run_id, seq);
create index cost_event_feed_idx on cost_event (engineering_run_id, seq);

-- `engineering_run` has had no creation time since M1. Its only anchors are `started_at`
-- (null until the run leaves CREATED) and `completed_at` (null until it is over), so a run
-- that has done neither cannot be ordered at all — which is why `listEngineeringRuns` orders
-- by a random uuid, and why `issue-commands.ts` has to scan for *any* run with an expired
-- approval rather than asking for the most recent one.
alter table engineering_run add column created_at timestamptz;

update engineering_run r set created_at = coalesce(
  (select min(at) from run_state_transition t where t.engineering_run_id = r.id),
  r.started_at,
  now()
);

alter table engineering_run alter column created_at set not null;
alter table engineering_run alter column created_at set default now();

create index engineering_run_created_at_idx on engineering_run (created_at desc, id);
