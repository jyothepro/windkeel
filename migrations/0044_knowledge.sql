-- Repository knowledge and memory (#388, ADR-0032).
--
-- Three things a maker is told about a repository besides its task, and one record of what it was
-- told. All of it shapes the maker's first prompt and nothing else: no table here is read by the
-- verifier, the criteria gate or the repair packet (ADR-0004, ADR-0029 — the verifier stays the
-- gate, and knowledge is never a path around it).
--
-- 1. `knowledge_note`: notes people write, for one repository or for the whole organization, and
--    lessons Orqon learns from its own runs. A learned lesson is risk-tiered by a deterministic
--    classifier (`src/factory/knowledge-risk.ts`): a low-risk descriptive fact is applied at once
--    (`active`), shown with where it came from and deletable; anything that could change what the
--    maker runs, touches secrets or the network, weakens tests, or names the verifier is held as
--    `suggested` until a person accepts it. Unclassifiable text is high risk.
-- 2. `knowledge_note_revision`: every version of every note, append-only, with who made it.
-- 3. `repository_digest`: a deterministic, model-free summary of files the repository already
--    ships (AGENTS.md, CONTRIBUTING.md, package.json scripts, …), per commit.
-- 4. `run_knowledge`: exactly what one run's maker was given, frozen when the session started
--    (the ADR-0027 discipline applied to knowledge). The body is copied, not referenced, so a note
--    edited or deleted later cannot rewrite what a finished run was told.

create table knowledge_note (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organization (id) on delete cascade,
  -- Null is organization-wide: it applies to every repository the organization works on.
  repository_id    uuid references repository (id) on delete cascade,
  title            text not null check (length(title) between 1 and 200),
  body             text not null check (length(body) between 1 and 8000),
  -- Empty applies always; otherwise only when the task names a path one of them matches.
  path_globs       text[] not null default '{}',
  status           text not null check (status in ('active', 'suggested', 'rejected', 'archived')),
  source_kind      text not null check (source_kind in ('human', 'repo_file', 'verifier_finding', 'pr_review')),
  -- Where a learned lesson came from: {"runId": …, "verificationRunId": …, "finding": …}.
  source_ref       jsonb not null default '{}',
  -- The classifier's verdict for a learned lesson; null for a note a person wrote.
  risk             text check (risk in ('low', 'high')),
  risk_reasons     text[] not null default '{}',
  -- sha256 of the normalised lesson text, so a lesson is learned once per repository.
  content_hash     text,
  version          integer not null default 1,
  -- Actors, in the `run_guidance.actor` convention: a login, or `orqon` for a learned lesson.
  created_by       text not null,
  updated_by       text not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index knowledge_note_scope_idx on knowledge_note (organization_id, repository_id, status);
create unique index knowledge_note_learned_hash_idx
  on knowledge_note (organization_id, repository_id, content_hash) where content_hash is not null;

create table knowledge_note_revision (
  note_id     uuid not null references knowledge_note (id) on delete cascade,
  version     integer not null,
  title       text not null,
  body        text not null,
  path_globs  text[] not null,
  status      text not null,
  actor       text not null,
  at          timestamptz not null default now(),
  primary key (note_id, version)
);

-- A learned lesson someone deleted. Kept so the next run with the same finding does not learn it
-- straight back: "deletable" has to mean it stays deleted.
create table knowledge_lesson_tombstone (
  organization_id  uuid not null references organization (id) on delete cascade,
  repository_id    uuid not null references repository (id) on delete cascade,
  content_hash     text not null,
  deleted_by       text not null,
  deleted_at       timestamptz not null default now(),
  primary key (organization_id, repository_id, content_hash)
);

create table repository_digest (
  repository_id  uuid not null references repository (id) on delete cascade,
  commit_sha     text not null,
  -- Rendered markdown, capped (`src/factory/repo-digest.ts`).
  body           text not null,
  -- [{path, bytes, sha256}] for each file that contributed.
  sources        jsonb not null,
  generated_at   timestamptz not null default now(),
  primary key (repository_id, commit_sha)
);

create table run_knowledge (
  id                  uuid primary key default gen_random_uuid(),
  engineering_run_id  uuid not null references engineering_run (id),
  -- No foreign key: a note deleted after the run must not take the run's record with it.
  note_id             uuid,
  note_version        integer,
  digest_sha          text,
  source_kind         text not null,
  risk                text,
  title               text not null,
  -- What the maker was shown, verbatim (possibly truncated to the budget).
  body                text not null,
  provenance          text not null,
  chars               integer not null,
  position            integer not null,
  recorded_at         timestamptz not null default now()
);

-- One entry per note (or the digest) per run, so a redelivered IMPLEMENTING cannot record twice.
create unique index run_knowledge_entry_idx
  on run_knowledge (engineering_run_id, coalesce(note_id::text, 'digest'));

update access_role set permissions = permissions || array['knowledge.manage'], updated_at = now()
 where key in ('admin', 'member') and account_id is null and not ('knowledge.manage' = any (permissions));
