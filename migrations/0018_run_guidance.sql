-- Guidance sent to a live maker (ADR-0023 §8).
--
-- The mechanism already existed — `WorkerAdapter.send()`, which the repair loop uses every turn
-- on a resumed session. What did not exist was a record of a *person* using it, and without one
-- a run's story has a gap exactly where a human intervened: the transcript would show the maker
-- changing direction with nothing to explain why.
--
-- Append-only, and it shares `run_event_seq` with the other two event tables so guidance can
-- join the feed later without a second cursor.
create table run_guidance (
  id                  uuid primary key default gen_random_uuid(),
  seq                 bigint not null default nextval('run_event_seq'),
  engineering_run_id  uuid not null references engineering_run (id),
  -- Who sent it. Not a foreign key: users do not exist until the Product UI milestone
  -- (ADR-0001), and the token subject is the honest answer until they do.
  actor               text not null,
  message             text not null,
  at                  timestamptz not null default now()
);

create index run_guidance_engineering_run_id_idx on run_guidance (engineering_run_id, seq);
create unique index run_guidance_seq_idx on run_guidance (seq);
