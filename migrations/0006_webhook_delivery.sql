-- Milestone 6 (ADR-0009 §2, ADR-0002 §3): what the webhook ingress writes.
--
-- GitHub redelivers. A delivery that produced a task and then failed to respond is retried with
-- the *same* `X-GitHub-Delivery`, and a second run for one issue is an expensive, visible,
-- embarrassing mistake — so the ingress needs a durable record of what it has already handled.

-- Why a table rather than a natural uniqueness constraint on what the event produced:
-- `issues.labeled` produces a task, which does have a natural key (below), but
-- `issue_comment.created` produces a `run_signal`, and an approval genuinely can arrive twice
-- with different meanings (an operator approving, then approving again after a re-plan). There
-- is no natural key for "this delivery", only for "this outcome", and the two are not the same
-- question. The delivery id is the only thing GitHub gives us that means "you have seen this
-- exact event", so it is what gets stored.
--
-- The row is written in the *same transaction* as the work the delivery causes. That ordering is
-- the point: if the work fails, the delivery record rolls back with it, GitHub retries, and the
-- retry does the work. Writing the record first and the work second would turn every failure
-- into a permanently dropped event, which is worse than a duplicate and much harder to notice.
create table webhook_delivery (
  delivery_id  text primary key,
  event        text not null,
  action       text,
  -- What the ingress decided this event meant (`interpret`'s intent kind), so a redelivery can
  -- be answered honestly and an operator can see why an event did nothing.
  intent       text not null,
  received_at  timestamptz not null default now()
);

create index webhook_delivery_received_at_idx on webhook_delivery (received_at);

-- One task per issue, enforced by the database rather than by the ingress reading before it
-- writes. Two *different* deliveries about the same issue (a label added, removed, and re-added
-- in quick succession; or GitHub fanning out a redelivery alongside the original) race, and a
-- select-then-insert loses that race. ADR-0009 §3 is explicit that re-labelling an issue whose
-- runs are all terminal starts a fresh **run on the same task** — so one task per issue is the
-- intended shape, not merely a convenient constraint.
--
-- Partial, because the local CLI path (ADR-0016) creates many tasks against one repository with
-- `source_type = 'local'` and no meaningful source reference; constraining those would break the
-- hermetic loop for no benefit.
create unique index engineering_task_github_issue_key
  on engineering_task (repository_id, source_reference)
  where source_type = 'github_issue';
