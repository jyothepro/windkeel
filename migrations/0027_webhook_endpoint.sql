-- Milestone 8 (M8-5, #297): signed inbound webhooks, and idempotent `POST /v1/tasks`.
--
-- A webhook endpoint is a URL (`/api/intake/webhook/{id}`) any system can POST a signed task to.
-- **Its secret is not stored.** Ingress can seal but never unseal (ADR-0014), so a secret it had to
-- read back on every delivery could not live here sealed — and it must not live here in the clear.
-- Instead the secret is *derived*: HMAC-SHA256(ORQON_WEBHOOK_SIGNING_KEY, "{id}:{secret_version}"),
-- shown once on create and on rotate. Rotation bumps `secret_version`, which is all it takes to make
-- every earlier secret for the endpoint stop verifying. See docs/webhook-intake.md.
create table webhook_endpoint (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references organization (id) on delete cascade,
  -- The repository the endpoint's tasks are for. It must be granted to the organization when the
  -- endpoint is made, and is re-checked on every delivery (a grant can be withdrawn later).
  repository_id            uuid not null references repository (id) on delete cascade,
  name                     text not null,
  secret_version           int not null default 1 check (secret_version >= 1),
  enabled                  boolean not null default true,
  default_risk_level       text not null default 'low'
                             check (default_risk_level in ('low', 'medium', 'high')),
  created_by_principal_id  uuid references principal (id) on delete set null,
  created_at               timestamptz not null default now(),
  rotated_at               timestamptz
);

create index webhook_endpoint_organization_idx on webhook_endpoint (organization_id);

-- `Idempotency-Key` on `POST /v1/tasks` is recorded in the one delivery ledger as `source = 'api'`,
-- in the task's own transaction. A replay with the same key must carry the same body, so the
-- ledger row keeps a SHA-256 of the canonical request body to tell a retry from a reused key.
-- Nullable: no other source has a request body worth comparing.
alter table intake_delivery add column if not exists request_hash text;

-- The answer the first request with a key was given (`{status, body}` — ids and flags, never the
-- request's content), so a replay returns it verbatim instead of re-deriving one from state that may
-- have changed since. Nullable, for the same reason as `request_hash`.
alter table intake_delivery add column if not exists response jsonb;
