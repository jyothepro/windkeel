-- Schedules: a task template plus a cron expression (M8-4, #296).
--
-- Each due slot becomes one engineering task through the M8-1 intake pipeline (source `schedule`,
-- `intake_delivery` key `schedule:{id}:{slotISO}`), created as the organization's `schedules`
-- system actor — never as the person who wrote the schedule (ADR-0024 §2).
--
-- `next_fire_at` is the one field the tick reads: it is always a slot of `cron` in `timezone`,
-- recomputed whenever either changes, and advanced to the first slot strictly after the tick.
--
-- `schedules.manage` already exists (migrations/0024); nothing is added to any role here.
--
-- **No object here is schema-qualified** (ADR-0024 §11).

create table schedule (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references organization (id),
  repository_id            uuid not null references repository (id),
  name                     text not null,
  cron                     text not null,
  timezone                 text not null default 'UTC',
  title                    text not null,
  description              text not null,
  risk_level               text not null default 'low' check (risk_level in ('low', 'medium', 'high')),
  spend_cap_usd            numeric check (spend_cap_usd is null or spend_cap_usd > 0),
  wall_clock_cap_seconds   int check (wall_clock_cap_seconds is null or wall_clock_cap_seconds > 0),
  enabled                  boolean not null default true,
  next_fire_at             timestamptz not null,
  last_fired_at            timestamptz,
  -- What the last tick did with this schedule: `created`, `existing`, `ignored:<reason>`, `failed:<status>`.
  last_outcome             text,
  -- Consecutive ticks whose intake for the current slot failed (a 5xx). Bounded: at
  -- `MAX_SLOT_ATTEMPTS` the slot is abandoned, `next_fire_at` advances, and the counter resets.
  consecutive_failures     int not null default 0,
  created_by_principal_id  uuid references principal (id),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- The tick's query: enabled schedules whose slot has come.
create index schedule_due_idx on schedule (next_fire_at) where enabled;
create index schedule_organization_id_idx on schedule (organization_id);
