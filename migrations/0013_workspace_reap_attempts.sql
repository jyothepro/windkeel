-- How many times the sandbox reaper has tried and failed to destroy this workspace's sandbox.
--
-- #198 requires the sweep to "record the outcome on the workspace row so a later sweep does not
-- retry forever". `status` alone cannot: `teardown_failed` is the outcome, and a sweep that
-- selects on it would re-select the same row every tick for as long as the deployment lives —
-- one permanently-unreachable sandbox producing an unbounded stream of failed provider calls,
-- which is a worse operational problem than the leak it is chasing.
--
-- A counter is the smallest thing that bounds it. The sweep excludes a workspace that has
-- reached the attempt cap, and an operator hunting a surprise bill can find exactly those rows
-- with one query — which is better than the alternative, where a stuck row is indistinguishable
-- from a healthy one.
--
-- Deliberately *not* a timestamp of the last attempt: the question a sweep asks is "have I given
-- up on this", not "when did I last try", and a column that invites backoff arithmetic invites
-- someone to write backoff arithmetic into a sweep that already has an interval.
alter table workspace add column reap_attempts integer not null default 0
  check (reap_attempts >= 0);

-- The sweep's own index: it selects live-but-reapable workspaces, which is a small slice of a
-- table that is mostly historical rows.
create index workspace_reap_idx on workspace (status, expires_at);
