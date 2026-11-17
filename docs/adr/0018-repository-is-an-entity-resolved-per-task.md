# ADR-0018: `Repository` is an entity, and a run resolves it per task

- Status: Accepted
- Date: 2026-09-06

## Context

ADR-0001 calls `repository_id` "the top-level scope" and ADR-0003's entity list never says what it points at.

## Decision

**`Repository` is a first-class entity, and a stage resolves its repository from the task.**

- §1 — The entity: (`migrations/0005_repository.sql`): `id`, `github_installation_id` (nullable — the local path has no installation), `owner`, `name`, `default_branch`, `clone_url`, timestamps, and `unique (owner, name)`.
- §2 — Upsert, not insert: Webhook delivery is at-least-once, so the intake path uses `on conflict (owner, name) do update`, letting the database arbitrate between concurrent deliveries instead of a select-then-insert that two of them would race.
- §3 — Resolution is per task: (`resolveRepositoryTarget`): a task whose repository row exists works against that row's clone URL and default branch.
- §4 — A missing row for a non-local task is an error, not a fallback.
- §5 — No foreign key yet, and the reason is recorded rather than skipped.

## Consequences

- `EngineeringTask.repository_id` finally means something, and "which repository did this run touch?" is answerable from data rather than from the environment of a process that has exited.
- The worker container stops being single-repository by construction.
- The CLI gains `--repository owner/name --clone-url … --default-branch …` and loses its invented uuid.
- Default branch is data everywhere downstream: nothing in the stage path may assume `main`.

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-09-06
- Amends: [ADR-0003](0003-factory-domain-model-and-run-state-machine.md) (factory domain model)
- Arises from: [#156 — M6.3](https://github.com/jyothepro/orqon/issues/156), Milestone 6

### Context

ADR-0001 calls `repository_id` "the top-level scope" and ADR-0003's entity list never says what it
points at. `migrations/0001_factory_schema.sql` therefore gave `engineering_task.repository_id` a
`uuid not null` column with no table behind it, and the local CLI filled it with a constant it
invented. Which repository a run actually worked against came from somewhere else entirely:
`StageConfig.repository`, container configuration, one repository per worker process.

That was coherent while a task could only be created by an operator sitting next to the container
that would run it. ADR-0009 makes it incoherent: an `issues.labeled` event arrives from a
repository, names it, and creates a task (§3); the run then has to clone that repository, cut a
branch from *its* default branch (§5), and mint a token scoped to *it* (ADR-0014 §2). None of
those facts can come from the container's environment without the container being wrong the first
time a second repository is installed.

`RepositoryTarget`'s doc comment in `src/factory/workflow/stage-deps.ts` has named this exact
limitation since M4 and said Milestone 6 was when it would end.

### Decision

**`Repository` is a first-class entity, and a stage resolves its repository from the task.**

1. **The entity** (`migrations/0005_repository.sql`): `id`, `github_installation_id` (nullable —
   the local path has no installation), `owner`, `name`, `default_branch`, `clone_url`,
   timestamps, and `unique (owner, name)`. One row per GitHub repository, not one per delivery.
2. **Upsert, not insert.** Webhook delivery is at-least-once, so the intake path uses
   `on conflict (owner, name) do update`, letting the database arbitrate between concurrent
   deliveries instead of a select-then-insert that two of them would race.
3. **Resolution is per task** (`resolveRepositoryTarget`): a task whose repository row exists
   works against that row's clone URL and default branch. `StageConfig.repository` survives only
   as the fallback for a task whose `source_type` is local — ADR-0016's hermetic path creates
   tasks against a bare git repo on disk with no repository row to read.
4. **A missing row for a non-local task is an error, not a fallback.** A task that came from
   outside and cannot find its repository is a bug in the intake that created it; falling back
   would run the factory against whichever repository the container happened to be configured
   for, which is how a candidate branch ends up pushed somewhere nobody asked for.
5. **No foreign key yet, and the reason is recorded rather than skipped.** Every task created
   before this migration carries an invented uuid matching no row, so the constraint would fail
   validation on any database with history, and backfilling would mean writing fiction into the
   table whose purpose is to record fact. `not valid` was rejected for the usual reason: it
   leaves a constraint that claims to hold and does not. From here on both intakes — the CLI and
   M6.5's GitHub path — create a real row first, so a later migration can add and validate the FK
   once no pre-0005 task remains.

### Consequences

- `EngineeringTask.repository_id` finally means something, and "which repository did this run
  touch?" is answerable from data rather than from the environment of a process that has exited.
- The worker container stops being single-repository by construction. It still *reads* a
  configured repository, but only tasks that declare themselves local can use it.
- The CLI gains `--repository owner/name --clone-url … --default-branch …` and loses its invented
  uuid. `--repository-id` remains for a caller that has already resolved one.
- Default branch is data everywhere downstream: nothing in the stage path may assume `main`.
- The missing FK is a known, dated gap with a stated exit condition, not an oversight. Until it
  closes, the invariant lives in `resolveRepositoryTarget`, which is enforced by tests rather
  than by the database.
