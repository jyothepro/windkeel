-- Merge as the person (ADR-0029 §5, integrated assistant phase 5, #371, G14).
--
-- Three things, all dormant until a deployment sets `ORQON_MERGE=1` and an organization's admin
-- turns on *Allow merging from Orqon*:
--
-- 1. `organization.allow_merge` — the organization setting, **off** by default.
-- 2. `github_user_authorization` — one row per person who authorized Orqon to merge as them: a
--    GitHub App user-to-server token and its refresh token, each **sealed separately** with the
--    sealed box v2 (`secret-box.ts`, ADR-0026 §2) under a context that binds the principal, the
--    GitHub user id and which of the two it is (`github_user_token:<principal>:<github user>:access`
--    / `…:refresh`). A ciphertext copied to another person's row, or access and refresh swapped,
--    fails to open. Ingress seals with the public key and can open neither; the merge step on the
--    stage side opens them, refreshes under `select … for update` on this row, and re-seals the new
--    pair in the same transaction. `needs_reauth` is the only state after a failed refresh: refresh
--    tokens are single use, so a refresh that succeeded at GitHub but was not stored has killed both.
-- 3. `run_merge` — the record of a merge made from Orqon: who, which PR, the SHA it was told to
--    merge (the verdict of record's candidate), what GitHub merged it into, the verdict of record
--    and its digest, and every *Needs a look* item the person acknowledged on a `warn`. The
--    `pull_request.closed` webhook still drives the run to `COMPLETED` (ADR-0009).
--
-- And one permission: `runs.merge`, held by the built-in Admin role. Orqon has no per-organization
-- role customization yet (built-in roles are global rows), so "grantable to Member" is not
-- expressible; an account-scoped `access_role` row is the seam when it is (docs/control-plane-api.md).
--
-- **No object here is schema-qualified** (ADR-0024 §11).

alter table organization add column allow_merge boolean not null default false;

create table github_user_authorization (
  principal_id             uuid primary key references principal (id) on delete cascade,
  -- GitHub's numeric id for the account that authorized. Checked against `principal.github_user_id`
  -- when stored and again before every merge: a person cannot authorize as a second account.
  github_user_id           bigint not null,
  github_login             text not null,
  sealed_access_token      text not null,
  -- Null when the App has *Expire user authorization tokens* off and GitHub issued no refresh token.
  sealed_refresh_token     text,
  keypair_id               text not null,
  access_expires_at        timestamptz,
  refresh_expires_at       timestamptz,
  status                   text not null default 'valid' check (status in ('valid', 'needs_reauth')),
  -- Why, in words Orqon wrote — never a GitHub response body.
  status_reason            text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  refreshed_at             timestamptz
);

create table run_merge (
  id                       uuid primary key default gen_random_uuid(),
  engineering_run_id       uuid not null references engineering_run (id),
  organization_id          uuid not null references organization (id),
  principal_id             uuid not null references principal (id),
  repository_id            uuid not null references repository (id),
  pr_number                integer not null,
  -- The verdict of record's candidate: the merge is sent with `sha` = this, so GitHub refuses it if
  -- the head moved.
  verified_sha             text not null,
  -- The commit GitHub reports the merge produced. Null until merged.
  merged_sha               text,
  verification_run_id      uuid not null references verification_run (id),
  verdict                  text not null check (verdict in ('pass', 'warn')),
  verdict_digest           text,
  -- `[{ id, title }]`, every Needs-a-look item the person ticked. Empty on a pass.
  acknowledgements         jsonb not null default '[]'::jsonb check (jsonb_typeof(acknowledgements) = 'array'),
  mark_ready               boolean not null default false,
  merge_method             text not null default 'squash' check (merge_method in ('merge', 'squash', 'rebase')),
  status                   text not null default 'pending'
                           check (status in ('pending', 'merged', 'refused', 'failed')),
  reason                   text,
  -- The GitHub login the person's token answered as, once it was checked.
  github_login             text,
  created_at               timestamptz not null default now(),
  completed_at             timestamptz
);

create index run_merge_engineering_run_id_idx on run_merge (engineering_run_id, created_at desc);
-- One merge in flight per run: a second click is a 409, not a second merge attempt.
create unique index run_merge_pending_idx on run_merge (engineering_run_id) where status = 'pending';

update access_role set permissions = permissions || array['runs.merge'], updated_at = now()
 where key = 'admin' and account_id is null and not ('runs.merge' = any (permissions));
