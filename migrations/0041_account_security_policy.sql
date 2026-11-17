-- Per-account security policy (#393 8F, ADR-0030): token lifetime, sign-in, network and audit
-- retention. No row means "no policy": the deployment defaults apply (ORQON_AUDIT_RETENTION_DAYS for
-- retention, 90 days unless set).

create table account_security_policy (
  account_id               uuid primary key references account (id),
  -- Tokens minted in this account expire within this many days; longer requests are clamped.
  max_token_ttl_days       integer check (max_token_ttl_days between 1 and 366),
  -- A token with no expiry is refused (or, with a maximum set, given the maximum).
  require_token_expiry     boolean not null default false,
  -- A signed-in session idle this long is refused; the person signs in again.
  idle_session_minutes     integer check (idle_session_minutes between 5 and 43200),
  -- Sessions must carry `aal2` (Supabase MFA).
  require_mfa              boolean not null default false,
  -- When set, API calls from any other address are refused 403 `ip_not_allowed`.
  ip_allowlist             cidr[],
  -- How long audit events are kept. Null: the deployment default.
  audit_retention_days     integer check (audit_retention_days between 30 and 3650),
  updated_by_principal_id  uuid references principal (id),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- A session's last request, for the idle timeout. Keyed by the JWT's `session_id`, so a new sign-in
-- starts fresh. Pruned by the audit retention sweep.
create table session_activity (
  session_id    text primary key,
  principal_id  uuid not null references principal (id) on delete cascade,
  last_seen_at  timestamptz not null
);
create index session_activity_last_seen_idx on session_activity (last_seen_at);
