-- The maker's own screenshots (#392): what the maker agent saw of the app it was building.
--
-- **Not evidence.** A row here is maker-authored and untrusted (ADR-0014: the maker is assumed
-- compromised). Nothing that verifies reads this table, nothing in an evidence package points at it,
-- and no verdict depends on it — see the ADR on maker screenshots. The bytes live in the object
-- store under `maker-browser/<engineering_run_id>/<sha256>.png`, apart from every evidence key.
--
-- **Idempotent by content.** `(engineering_run_id, sha256)` is unique, so a redelivered harvest of
-- the same files inserts nothing, and the object key is the hash, so a re-upload overwrites a file
-- with itself.
--
-- **Ordered by `seq`, not `captured_at`.** One harvest inserts all its rows in one transaction, where
-- `now()` is a single instant, so `captured_at` ties and cannot order them. `seq` is drawn per row in
-- insert order (the harvest inserts in the helper's file order), so a run's screenshots list the
-- same way every time.
create table maker_screenshot (
  id                  uuid primary key default gen_random_uuid(),
  seq                 bigint generated always as identity unique,
  engineering_run_id  uuid not null references engineering_run (id),
  agent_run_id        uuid references agent_run (id),
  sha256              text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  object_key          text not null,
  bytes               integer not null check (bytes > 0),
  -- What the maker's helper wrote beside the file. Untrusted text, capped at write time.
  name                text,
  url                 text,
  page_title          text,
  console_errors      jsonb not null default '[]'::jsonb,
  captured_at         timestamptz not null default now(),
  unique (engineering_run_id, sha256)
);

create index maker_screenshot_run_idx on maker_screenshot (engineering_run_id, seq);

-- Two events Orqon writes on the agent's feed itself, rather than the agent's stream:
--
-- * `screenshot` — one per harvested screenshot, payload `{screenshotId, name, url}`, so a screenshot
--   appears in the feed where it was taken, ordered by `seq` like everything else.
-- * `browser_unavailable` — the maker was meant to have a browser and the install failed; payload
--   `{reason}`. At most one per agent run.
--
-- Neither comes from the agent's event stream, so neither has a stream `ordinal`: the column becomes
-- nullable for exactly these two types, and their idempotency is their own — the screenshot row's
-- unique key (inserted in the same transaction) and the partial unique index below.
alter table agent_event drop constraint agent_event_type_check;
alter table agent_event add constraint agent_event_type_check check (type in (
  'started', 'thinking', 'command_started', 'command_finished',
  'test_started', 'test_finished', 'file_changed', 'message',
  'completed', 'failed',
  'screenshot', 'browser_unavailable'
));
alter table agent_event alter column ordinal drop not null;
alter table agent_event add constraint agent_event_ordinal_origin check (
  ordinal is not null or type in ('screenshot', 'browser_unavailable')
);
create unique index agent_event_browser_unavailable_once
  on agent_event (agent_run_id) where type = 'browser_unavailable';

-- What the maker's browser install came to, on the maker's workspace row: `{status, reason?,
-- helper?, startCommand?, port?, durationMs}`. Null when none was attempted.
alter table workspace add column maker_browser jsonb;
