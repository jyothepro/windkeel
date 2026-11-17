-- Accounts, organizations, principals and scoped API tokens (ADR-0024).
--
-- Additive: every table here is new, and the three changes to existing tables add columns. The
-- backfill at the end puts every existing row where a single-tenant deployment would have put it:
-- one account, one organization called `default`, every repository granted to it, every task and
-- secret owned by it. Nothing is invented (ADR-0018 §5).
--
-- **No object here is schema-qualified.** The database is shared between several products and
-- Orqon's tables live in the `orqon` schema, chosen by the connection's `search_path`. The test
-- suite gives each file its own schema the same way, so a qualifier would break both
-- (ADR-0024 §11). Nothing refers to Supabase's `auth` schema either: people are linked through
-- `user_identity`, with no foreign key into a schema other products share (ADR-0024 §5).

-- The customer. It owns SCM connections, and later SSO, billing and audit.
create table account (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  -- The account a deployment falls back to when nothing names one: a GitHub installation seen for
  -- the first time, the local path, the bootstrap token. Exactly one, enforced below.
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index account_is_default_idx on account (is_default) where is_default;

-- The unit that owns work: tasks, runs, secrets, guidance. A customer with two teams has two.
create table organization (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references account (id),
  name        text not null,
  -- Where work lands when nothing says otherwise, as `account.is_default` is for accounts.
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index organization_account_id_name_idx on organization (account_id, name);
create unique index organization_is_default_idx on organization (is_default) where is_default;

-- Anything that acts: a person today. `kind` leaves room for organization tokens (ADR-0024 §6),
-- which act as themselves and therefore need an identity of their own to be named in audit columns.
create table principal (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references account (id),
  kind            text not null check (kind in ('user', 'token')),
  display_name    text not null,
  -- GitHub's numeric id, not the login: logins can be renamed and reused. It is what lets a GitHub
  -- commenter and an Orqon user be recognised as the same person.
  github_user_id  bigint unique,
  github_login    text,
  -- The principal `ORQON_API_TOKEN` authenticates as. Seeded once below; break-glass (ADR-0024 §6).
  is_bootstrap    boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index principal_is_bootstrap_idx on principal (is_bootstrap) where is_bootstrap;

-- How a person signs in. Supabase Auth today (`provider = 'supabase'`, `subject = auth.users.id`),
-- deliberately without a foreign key: a row in the shared `auth.users` grants nothing in Orqon
-- until one of these exists (ADR-0024 §5).
create table user_identity (
  id            uuid primary key default gen_random_uuid(),
  principal_id  uuid not null references principal (id) on delete cascade,
  provider      text not null,
  subject       text not null,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz
);
create unique index user_identity_provider_subject_idx on user_identity (provider, subject);
create index user_identity_principal_id_idx on user_identity (principal_id);

-- A role is a set of named permissions, so a new permission or a custom role is a row rather than
-- a schema change. Built-in roles have no account and are identified by `key`.
create table access_role (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid references account (id),
  key          text not null,
  name         text not null,
  permissions  text[] not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index access_role_builtin_key_idx on access_role (key) where account_id is null;
create unique index access_role_account_id_key_idx on access_role (account_id, key)
  where account_id is not null;

-- One role per principal per organization.
create table membership (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organization (id) on delete cascade,
  principal_id     uuid not null references principal (id) on delete cascade,
  access_role_id   uuid not null references access_role (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index membership_organization_id_principal_id_idx
  on membership (organization_id, principal_id);
create index membership_principal_id_idx on membership (principal_id);

-- At most one account-wide role, which applies in every organization of the account.
create table account_membership (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references account (id) on delete cascade,
  principal_id    uuid not null references principal (id) on delete cascade,
  access_role_id  uuid not null references access_role (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index account_membership_account_id_principal_id_idx
  on account_membership (account_id, principal_id);

-- One kind of API token, owned by a user and scoped when it is made (ADR-0024 §6). Its power is
-- its owner's role intersected with `permissions`, so a token can only ever be narrower than the
-- person who holds it. Only the SHA-256 is stored; the value is shown once.
create table api_token (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null,
  owner_principal_id      uuid not null references principal (id) on delete cascade,
  -- When set, the token works in this organization only.
  organization_id         uuid references organization (id) on delete cascade,
  permissions             text[] not null,
  created_by_principal_id uuid references principal (id),
  -- The first characters of the value, so a person can tell their tokens apart. Never enough to use.
  prefix                  text not null,
  hash                    text not null,
  created_at              timestamptz not null default now(),
  last_used_at            timestamptz,
  expires_at              timestamptz,
  revoked_at              timestamptz
);
create unique index api_token_hash_idx on api_token (hash);
create index api_token_owner_principal_id_idx on api_token (owner_principal_id);

-- A GitHub App installation, owned by an account. `repository.github_installation_id` stays where
-- ADR-0018 put it; this is what says whose installation it is.
create table scm_connection (
  id               uuid primary key default gen_random_uuid(),
  account_id       uuid not null references account (id),
  provider         text not null default 'github',
  installation_id  bigint not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index scm_connection_provider_installation_id_idx
  on scm_connection (provider, installation_id);

-- What lets an organization work on a repository. No grant, no access (ADR-0024 §2).
create table repository_grant (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references organization (id) on delete cascade,
  repository_id           uuid not null references repository (id) on delete cascade,
  -- The organization a GitHub label on this repository creates its task in. At most one.
  intake                  boolean not null default false,
  created_by_principal_id uuid references principal (id),
  created_at              timestamptz not null default now()
);
create unique index repository_grant_organization_id_repository_id_idx
  on repository_grant (organization_id, repository_id);
create unique index repository_grant_intake_idx on repository_grant (repository_id) where intake;

-- An invitation to an organization, by GitHub user id resolved from the login when it is made, so a
-- renamed account still matches. Accepted on the invitee's first sign-in (ADR-0024 §12).
create table invitation (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references organization (id) on delete cascade,
  github_user_id           bigint not null,
  github_login             text not null,
  access_role_id           uuid not null references access_role (id),
  invited_by_principal_id  uuid references principal (id),
  created_at               timestamptz not null default now(),
  expires_at               timestamptz not null,
  accepted_at              timestamptz,
  accepted_by_principal_id uuid references principal (id)
);
create unique index invitation_pending_idx on invitation (organization_id, github_user_id)
  where accepted_at is null;

-- The CLI's device login (ADR-0024 §12). The token is minted on the poll that follows approval,
-- not at approval, so its value is never stored anywhere, even briefly.
create table device_authorization (
  id                        uuid primary key default gen_random_uuid(),
  device_code_hash          text not null,
  user_code                 text not null,
  machine_name              text not null,
  permissions               text[] not null,
  organization_id           uuid references organization (id) on delete cascade,
  state                     text not null default 'pending'
                              check (state in ('pending', 'approved', 'denied', 'consumed')),
  decided_by_principal_id   uuid references principal (id),
  api_token_id              uuid references api_token (id),
  created_at                timestamptz not null default now(),
  expires_at                timestamptz not null,
  last_polled_at            timestamptz,
  decided_at                timestamptz
);
create unique index device_authorization_device_code_hash_idx
  on device_authorization (device_code_hash);
create unique index device_authorization_user_code_idx on device_authorization (user_code)
  where state = 'pending';

-- Existing tables. A task says which organization's work it is, because once a repository can be
-- granted to two organizations the repository no longer can (ADR-0024 §3).
alter table engineering_task add column organization_id uuid references organization (id);
-- A secret belongs to an organization's use of a repository, so two organizations sharing one
-- cannot read each other's registry credentials.
alter table repository_secret add column organization_id uuid references organization (id);
-- Who acted, as a principal, beside the text that was always recorded. Nullable because a GitHub
-- commenter approving by comment need not be an Orqon user (ADR-0024 §9).
alter table repository_secret add column set_by_principal_id uuid references principal (id);
alter table run_guidance add column actor_principal_id uuid references principal (id);

-- Backfill ------------------------------------------------------------------

insert into account (name, is_default) values ('default', true);
insert into organization (account_id, name, is_default)
  select id, 'default', true from account where is_default;

insert into access_role (key, name, permissions) values
  ('admin', 'Admin', array['runs.read', 'runs.write', 'runs.approve', 'secrets.manage',
                           'repositories.manage', 'members.manage', 'tokens.manage']),
  ('member', 'Member', array['runs.read', 'runs.write', 'runs.approve']),
  ('viewer', 'Viewer', array['runs.read']);

insert into principal (account_id, kind, display_name, is_bootstrap)
  select id, 'user', 'operator', true from account where is_default;
insert into account_membership (account_id, principal_id, access_role_id)
  select a.id, p.id, r.id
    from account a, principal p, access_role r
   where a.is_default and p.is_bootstrap and r.key = 'admin' and r.account_id is null;
insert into membership (organization_id, principal_id, access_role_id)
  select o.id, p.id, r.id
    from organization o, principal p, access_role r
   where o.is_default and p.is_bootstrap and r.key = 'admin' and r.account_id is null;

insert into scm_connection (account_id, installation_id)
  select a.id, installations.id
    from account a,
         (select distinct github_installation_id as id from repository
           where github_installation_id is not null) installations
   where a.is_default;

insert into repository_grant (organization_id, repository_id, intake)
  select o.id, r.id, true from organization o, repository r where o.is_default;

update engineering_task set organization_id = (select id from organization where is_default);
update repository_secret set organization_id = (select id from organization where is_default);
update run_guidance set actor_principal_id = (select id from principal where is_bootstrap)
  where actor = 'operator';
update repository_secret set set_by_principal_id = (select id from principal where is_bootstrap)
  where set_by = 'operator';

alter table engineering_task alter column organization_id set not null;
alter table repository_secret alter column organization_id set not null;

create index engineering_task_organization_id_idx on engineering_task (organization_id, created_at);

drop index repository_secret_key_idx;
create unique index repository_secret_key_idx
  on repository_secret (organization_id, repository_id, key);
