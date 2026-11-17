-- The GitHub account behind a Supabase user, for the ingress session verifier (ADR-0024 §5,
-- amendment of 2026-10-16). NOT run by `runMigrations`, which reads only `migrations/*.sql`: it
-- reaches into Supabase's `auth` schema, which stock Postgres (ADR-0008, ADR-0016) does not have and
-- which `orqon_app` cannot read. An operator applies it once, as `postgres`, in the SQL editor of the
-- Supabase project, and again whenever this file changes. It is idempotent.
--
-- Why a function: a session's GitHub id must come from `auth.identities`, which only Supabase Auth
-- writes — never from the token's `user_metadata`, which the user writes. A grant on
-- `auth.identities` would let Orqon read every product's users (emails included) on this shared
-- project; this returns one user's GitHub id, login and name and nothing else, and `orqon_app` may
-- execute it and do nothing more in `auth`. Asking Auth over HTTP (`GET /auth/v1/user`) was refused
-- because Supabase documents that endpoint as IP rate-limited, and ingress calls from shared egress.
--
-- `security definer` with an empty `search_path`, so every name below is schema-qualified and no
-- caller-controlled schema can shadow one. A deleted or banned user has no GitHub account here.
-- The names are qualified with `orqon.` (unlike migrations) because `postgres`'s search_path is not
-- `orqon_app`'s.

create or replace function orqon.github_identity_of(subject uuid)
returns table (github_user_id text, github_login text, display_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select i.provider_id,
         coalesce(i.identity_data ->> 'user_name', i.identity_data ->> 'preferred_username'),
         coalesce(i.identity_data ->> 'full_name', i.identity_data ->> 'name')
    from auth.identities i
    join auth.users u on u.id = i.user_id
   where i.user_id = subject
     and i.provider = 'github'
     and u.deleted_at is null
     and (u.banned_until is null or u.banned_until <= now())
$$;

revoke all on function orqon.github_identity_of(uuid) from public;
do $$
begin
  -- Supabase's API roles get execute on new functions by default privileges; take it back.
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function orqon.github_identity_of(uuid) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function orqon.github_identity_of(uuid) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function orqon.github_identity_of(uuid) from service_role';
  end if;
end
$$;
grant execute on function orqon.github_identity_of(uuid) to orqon_app;
