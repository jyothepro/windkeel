-- Retention for stored captures (#288, ADR-0015 amendment 2026-10-20).
--
-- `POST /v1/runs/{id}/capture` (#286) copies a maker sandbox's scratch directory into the evidence
-- bucket under `captures/<run-id>/`. Nothing recorded that it had, so the retention sweep — which
-- finds evidence through `verification_run.evidence_package_ref` — could not find a capture, and
-- captures grew forever.
--
-- `run_capture` is the anchor: one row per run (a later capture overwrites the earlier one at the
-- same key, so one row is the truth), written after the objects are stored. The sweep deletes the
-- objects of a row whose `captured_at` is past the window, **then** stamps `pruned_at` — objects
-- first, row second, so a sweep killed in between leaves a row that still qualifies and is finished
-- off on the next tick. The row is kept after pruning so `GET /v1/runs/{id}/capture` can answer
-- `pruned` rather than an empty list that reads as "never captured".
--
-- Additive only: a new table. A capture stored before this migration has no row, is unknown to the
-- sweep, and is kept (see the amendment for why that is the chosen behaviour, not an oversight).
--
-- **No object here is schema-qualified** (ADR-0024 §11).

create table run_capture (
  engineering_run_id uuid primary key references engineering_run (id) on delete cascade,
  -- Where the objects are: the bucket and the key prefix passed to `putPackage`.
  bucket             text not null,
  object_key         text not null,
  -- Sum of the stored files' sizes, so storage cost is a query rather than a bucket scan.
  byte_total         bigint not null check (byte_total >= 0),
  captured_at        timestamptz not null default now(),
  -- Set by the retention sweep after the objects are deleted. Null: stored.
  pruned_at          timestamptz
);

-- The sweep's query: unpruned captures, oldest first.
create index run_capture_unpruned_by_age on run_capture (captured_at) where pruned_at is null;
