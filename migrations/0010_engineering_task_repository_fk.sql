-- The foreign key `migrations/0005` deferred, now that its exit condition is met.
--
-- 0005 created the `repository` table and deliberately left `engineering_task.repository_id`
-- unconstrained, because every task created before it carried a uuid the local CLI invented out
-- of thin air (`src/commands/task.ts`, M4.1). It named the exit condition precisely:
--
--   > Once no pre-0005 task remains, a later migration can add and validate the FK in one step.
--
-- Whether that holds is a property of the *data*, not of this file, and it differs between a
-- fresh database and one with history. So this migration checks before it constrains, and the
-- check is the first thing it does.
--
-- On the databases this project actually has, the answer is that no such task exists — because
-- no database with pre-0005 history exists. Orqon has never been deployed (#176), the only
-- Postgres it has ever run against is a scratch database whose schemas are created and dropped
-- per test file, and both intake paths have created a real `repository` row since 0005: the CLI
-- through `resolveRepositoryId`, which refuses a task with no repository rather than defaulting
-- one, and M6.5's GitHub intake, which upserts from the delivery. The condition is met by
-- absence, and that is worth writing down rather than leaving as an assumption a reader has to
-- reconstruct.
--
-- `not valid` is not used, for the reason 0005 gives and which has not changed: it leaves a
-- constraint that claims to hold and does not.

-- The check runs first and aborts the transaction with a message an operator can act on. A raw
-- foreign-key violation would say `insert or update on table "engineering_task" violates foreign
-- key constraint` and name no row — true, and useless to someone deciding what to do about it.
-- This one names the count and the query that finds them.
do $$
declare
  orphans bigint;
begin
  select count(*) into orphans
    from engineering_task t
   where not exists (select 1 from repository r where r.id = t.repository_id);

  if orphans > 0 then
    raise exception using
      errcode = 'foreign_key_violation',
      message = format(
        '%s engineering_task row(s) point at a repository_id with no repository row, so the '
        'foreign key migrations/0005 deferred cannot be validated yet.', orphans),
      detail =
        'These are pre-0005 tasks carrying uuids the local CLI invented (src/commands/task.ts, '
        'M4.1). Do NOT satisfy the constraint by inventing repository rows for them: the '
        'repository table exists to be the record of fact, and an owner, name, and clone URL '
        'nobody ever recorded would be fiction. List them with: select t.id, t.source_type, '
        't.repository_id from engineering_task t where not exists (select 1 from repository r '
        'where r.id = t.repository_id);',
      hint =
        'Each orphan is either dead (no engineering_run, and therefore no verification_run, '
        'repair_attempt, cost_event, or workspace) and may be deleted, or it has run history and '
        'must be kept — in which case this migration stays unapplied and the invariant remains '
        'enforced in code by resolveRepositoryTarget (src/factory/workflow/repository-target.ts).';
  end if;
end $$;

-- No `on delete` clause, so the default `no action` applies: a repository with tasks against it
-- cannot be deleted. That is the correct direction. `cascade` would let one delete take a run's
-- entire history with it, and `set null` is impossible against a `not null` column — which is
-- itself the right shape, since a task with no repository is not a task this system can run.
alter table engineering_task
  add constraint engineering_task_repository_id_fkey
  foreign key (repository_id) references repository (id);

-- `resolveRepositoryTarget` keeps enforcing the same invariant in code, and that is not
-- redundancy to be tidied away later. It refuses *loudly and by name* for a GitHub-sourced task
-- whose repository row is missing, which is the message an operator can act on; and it is the
-- only enforcement that exists on a database where this migration has not been applied. The
-- constraint is a second line of defence, not a replacement for the first.
