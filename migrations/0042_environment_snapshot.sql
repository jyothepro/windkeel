-- Per-repository environment snapshots (#387, ADR-0031).
--
-- A snapshot is a provider-level disk image of a **setup sandbox**: a sandbox that cloned the
-- repository at its default branch, ran the dependency install and the `setup` declared in
-- `orqon.config.json` *at that same commit*, with the repository's own secrets, and was then
-- scanned for those secrets and snapshotted. No maker process ever ran in it (ADR-0004: caching is
-- legitimate exactly when the cached state predates any maker involvement). Maker and verifier
-- workspaces restore from a matching `ready` row instead of cold-cloning, and fall back to the cold
-- path otherwise.
--
-- 1. `environment_snapshot` — one row per build attempt.
--    * `organization_id` because the build used *that organization's* repository secrets, and a
--      repository shared with another organization must never receive them (ADR-0024 §3) — not
--      even baked into a disk image.
--    * `cache_key` is a sha256 over the inputs that determine the environment (see
--      `src/sandbox/environment-snapshot.ts`); never over a secret's value.
--    * `key_paths` are the paths the key covered, so a restore can diff exactly those paths between
--      `base_sha` and the commit it checked out, and skip the install only when none changed.
--    * The partial unique index is the build lock: at most one `building`-or-`ready` row per key,
--      so two runs that miss at once cannot both build.
-- 2. `environment_snapshot_request` — the intent to build (ADR-0023: writes are intents). A run that
--    misses, or `POST …/environment/rebuild`, records one; the sweep claims it on the stage side,
--    which is the only side that can open the secrets the build needs. One pending row per
--    repository and organization: asking twice is asking once.
-- 3. `workspace.environment_snapshot_id` / `workspace.environment_mode` — which snapshot a
--    workspace was restored from, and whether it was. `environment_mode` stays null when the
--    feature is off, so a deployment that never turns it on reads exactly as before.

create table environment_snapshot (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references organization (id) on delete cascade,
  repository_id        uuid not null references repository (id) on delete cascade,
  sandbox_provider     text not null,
  format_version       integer not null,
  cache_key            text not null,
  key_paths            text[] not null default '{}',
  base_sha             text not null,
  provider_snapshot_id text,
  status               text not null
    check (status in ('building', 'ready', 'failed', 'invalidated', 'expired')),
  detail               text,
  setup_log_ref        text,
  size_bytes           bigint,
  built_by             text not null,
  -- `setup-detection.ts`'s draft from the same checkout: a suggestion for a person, never run.
  proposed_setup       jsonb,
  created_at           timestamptz not null default now(),
  ready_at             timestamptz,
  expires_at           timestamptz,
  last_used_at         timestamptz
);

create unique index environment_snapshot_ready_key_idx
  on environment_snapshot (organization_id, repository_id, sandbox_provider, cache_key)
  where status in ('building', 'ready');

create index environment_snapshot_repository_idx
  on environment_snapshot (repository_id, created_at desc);

create table environment_snapshot_request (
  organization_id uuid not null references organization (id) on delete cascade,
  repository_id   uuid not null references repository (id) on delete cascade,
  requested_by    text not null,
  reason          text not null,
  requested_at    timestamptz not null default now(),
  primary key (organization_id, repository_id)
);

alter table workspace
  add column environment_snapshot_id uuid references environment_snapshot (id) on delete set null,
  add column environment_mode text check (environment_mode in ('snapshot', 'cold'));
