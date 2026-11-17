-- Milestone 8 (ADR-0025 §4): one delivery ledger for every intake source.
--
-- `webhook_delivery` (migrations/0006) was GitHub's. M8 adds Slack, Linear, Jira, signed webhooks
-- and schedules, and ADR-0025 §4 is explicit that for the Connect-carried sources *this table is
-- the only record of what arrived* — Connect keeps no per-event log. So the ledger is keyed on
-- (source, delivery_key) rather than on GitHub's delivery id alone, and it now records ignored
-- events too, with their reason: "I added the label and nothing happened" has to be answerable
-- from the database, not only from the HTTP response a provider threw away.
--
-- The contract is unchanged from 0006: the row is written in the *same transaction* as the work
-- the delivery causes, so a failed delivery leaves no record claiming it was handled.
create table intake_delivery (
  -- 'github' | 'slack' | 'linear' | 'jira' | 'webhook' | 'schedule' — the `IntakeSource.name`.
  source              text not null,
  -- The provider's own "you have seen this exact event" id (GitHub: X-GitHub-Delivery).
  delivery_key        text not null,
  -- Whose delivery this was, when the source could tell. GitHub's ingress resolves the
  -- organization from the task it touched; an unknown Slack workspace has none.
  organization_id     uuid references organization (id) on delete set null,
  event               text,
  action              text,
  -- What the intake decided (`create_task:started`, `ignore`, …).
  intent              text not null,
  -- Why an ignored event was ignored. Never payload content.
  reason              text,
  engineering_task_id uuid references engineering_task (id) on delete set null,
  received_at         timestamptz not null default now(),
  primary key (source, delivery_key)
);

create index intake_delivery_received_at_idx on intake_delivery (received_at);
-- The retention sweep's predicate: ignored rows past their 30 days.
create index intake_delivery_ignored_received_at_idx
  on intake_delivery (received_at) where intent = 'ignore';

-- Every GitHub delivery recorded before this migration still deduplicates after it: a redelivery
-- of an event handled yesterday must answer `duplicate`, not start a second run.
insert into intake_delivery (source, delivery_key, event, action, intent, received_at)
select 'github', delivery_id, event, action, intent, received_at
  from webhook_delivery;

-- Dropped rather than kept as a view. A view over intake_delivery would keep `select` working, but
-- the old table's only writers were the ingress (moved here in the same change) and nothing reads
-- it outside this repository; an updatable view would also quietly accept inserts that bypass the
-- (source, delivery_key) key. One ledger, one name.
drop table webhook_delivery;

-- Where a source's outcome notifier finds its way back: a Slack channel and thread, a Linear issue
-- id, a Jira issue key. Routing only — never a token, never a secret (ADR-0014).
alter table engineering_task add column source_context jsonb not null default '{}';

-- Who created the task, as a principal (ADR-0024 §2): the API caller, or an organization's service
-- principal for an automation. Nullable: the GitHub label path and every pre-M8 task have none.
--
-- migrations/0024 (M8-2) adds the same column. The runner applies *any* unapplied file, so a
-- database that already ran 0024 (and 0025) from the base branch runs this file afterwards: both
-- files therefore add the column and its foreign key only if absent, and whichever runs first
-- wins. Either order ends with one column and one FK (`on delete set null`).
alter table engineering_task add column if not exists created_by_principal_id uuid;
do $$
begin
  if not exists (
    select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
      join pg_attribute a on a.attrelid = t.oid and a.attnum = any (c.conkey)
     where c.contype = 'f'
       and t.relname = 'engineering_task'
       and n.nspname = current_schema()
       and a.attname = 'created_by_principal_id'
  ) then
    alter table engineering_task
      add constraint engineering_task_created_by_principal_id_fkey
      foreign key (created_by_principal_id) references principal (id) on delete set null;
  end if;
end
$$;

-- One task per (organization, source, reference) for every source that has a meaningful reference.
-- GitHub keeps 0006's (repository_id, source_reference) index. `local` is excluded for the reason
-- 0006 gave: the CLI path creates many tasks with the same placeholder reference. `api` references
-- are `api:{actor}:{epoch ms}`, unique in practice, so they are covered.
create unique index engineering_task_source_key
  on engineering_task (organization_id, source_type, source_reference)
  where source_type not in ('github_issue', 'local');
