-- Milestone 6: the Repository entity (ADR-0018, amending ADR-0003).
--
-- ADR-0001 calls `repository_id` "the top-level scope" and ADR-0003's entity list never defines
-- what it points at, so migrations/0001 left `engineering_task.repository_id` a bare uuid with no
-- table behind it. That was consistent while a task could only be created by the local CLI
-- against one container-configured repository; it stops being consistent the moment an issue
-- from a GitHub repository creates a task (ADR-0009 §3), because the task itself has to say which
-- repository it came from and which installation can reach it.

create table repository (
  id                     uuid primary key default gen_random_uuid(),
  -- The installation that can reach this repository (ADR-0009 §1, ADR-0014 §2). bigint because
  -- GitHub's installation ids are not guaranteed to fit in an int, and nullable because the
  -- local-CLI path has a repository with no installation at all.
  github_installation_id bigint,
  owner                  text not null,
  name                   text not null,
  -- Data, not a hard-coded "main": ADR-0009 §5 cuts working branches from *the repository's*
  -- default branch, and plenty of repositories do not call it main.
  default_branch         text not null,
  clone_url              text not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  -- One row per GitHub repository, not one per installation event: webhook delivery is
  -- at-least-once, so the upsert path needs a conflict target (ADR-0018).
  constraint repository_owner_name_key unique (owner, name)
);

-- No foreign key from `engineering_task.repository_id` yet, and that is deliberate rather than
-- forgotten.
--
-- Every task created before this migration carries a repository uuid the local CLI invented out
-- of thin air (src/commands/task.ts, M4.1), and those uuids match no row here. Adding the
-- constraint would fail validation on any database with history, and backfilling would mean
-- inventing an owner, a name, and a clone URL for repositories nobody ever recorded — writing
-- fiction into the table whose whole point is to be the record of fact. `not valid` was
-- considered and rejected for the same reason it usually is: it leaves a constraint that claims
-- to hold and does not.
--
-- From this migration forward the CLI creates a real repository row (so new local tasks are
-- referentially sound too), and M6.5's GitHub intake never had synthetic ids. Once no
-- pre-0005 task remains, a later migration can add and validate the FK in one step. Until then
-- `resolveRepositoryTarget` (src/factory/workflow/repository-target.ts) enforces the invariant in
-- code and refuses loudly for a GitHub-sourced task whose repository row is missing.
-- (`engineering_task_repository_id_idx` from migrations/0001 already indexes the join column, so
-- there is nothing else this migration needs to add for it.)

-- Appended by migrations/0010 (issue #180), which is where the foreign key above finally lands.
-- The situation this comment describes has changed, and the honest record of how is short: it
-- did not change because orphan tasks were cleaned up. It changed because none were ever
-- created outside a test schema — Orqon has never been deployed, so no database with pre-0005
-- history exists to hold one. The exit condition named above was met by absence rather than by
-- work, and 0010 checks for orphans before constraining rather than assuming that stays true of
-- every database this migration is ever run against.
