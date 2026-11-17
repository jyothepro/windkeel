-- Jira webhooks Orqon registered and must not lose track of (#313, the re-review of #310).
--
-- Atlassian allows 5 webhooks per app per site, so a webhook Jira holds and no row records is a
-- slot lost for good. Two additions, both additive: code built before them neither reads nor
-- writes them, and they start empty.
--
-- 1. `jira_webhook.retired_webhook_ids` — ids this connection registered and no longer wants: the
--    ones a re-registration replaced, recorded in the same transaction that records their
--    replacements, before they are deleted at Jira. A delete that fails (or never runs) leaves
--    them here, and the next `ensure`, the sweep, or disconnect deletes them. So every id Jira
--    hands back is, at every commit, in `webhook_ids`, in `retired_webhook_ids`, or already
--    deleted at Jira (an `ensure` whose record fails to commit deletes what it just registered).
--
-- 2. `jira_webhook_dirty` — "this connection's routes changed while an `ensure` for it was
--    running". A route change whose `ensure` finds the connection busy marks it here instead of
--    giving up; the `ensure` holding the connection re-runs when it finishes, and the hourly sweep
--    takes marked connections first. `generation` grows with each mark: the holder clears only the
--    generation it read before it read the routes, so a mark made after that survives for the
--    re-run. A separate table, so marking never waits on the holder's lock of `jira_webhook`.
--
-- **No object here is schema-qualified** (ADR-0024 §11).

alter table jira_webhook
  add column retired_webhook_ids bigint[] not null default '{}';

create table jira_webhook_dirty (
  connection_id  uuid primary key references integration_connection (id) on delete cascade,
  generation     bigint not null default 1,
  marked_at      timestamptz not null default now()
);
