-- Sentry as a fourth integration provider (#389): alerts in, verifier-aware comments back.
--
-- 1. `integration_connection.provider` and `integration_route.scope_kind` gain `sentry` and
--    `sentry_project`. A Sentry connection's `external_tenant_id` is the Sentry *installation
--    uuid* (`installation.uuid` in every webhook body) and `external_tenant_name` the Sentry
--    organization slug. Its `installation_id` holds the same uuid: Sentry is not carried by
--    Vercel Connect, so there is no Connect installation to name.
-- 2. `sentry_credential` holds the token the post-back comments with, **sealed** — the
--    documented Sentry-only exception to ADR-0025 §1's "store no provider token" (ADR-0034).
--    The value is a v2 sealed box (`secret-box.ts`, ADR-0026 §2) bound to
--    `sentry_credential:<organization_id>:<connection_id>`: ingress seals it with
--    `ORQON_SECRET_PUBLIC_KEY` and cannot open it; only the flow function's notifier, holding
--    `ORQON_SECRET_PRIVATE_KEY`, opens it, inside one call. Nothing selects it but that reader.
--
-- The `sentry` system actor needs no seed: `getSystemActor` creates it on first use, like `jira`.
--
-- **No object here is schema-qualified** (ADR-0024 §11).

alter table integration_connection drop constraint integration_connection_provider_check;
alter table integration_connection add constraint integration_connection_provider_check
  check (provider in ('slack', 'linear', 'jira', 'sentry'));

alter table integration_route drop constraint integration_route_scope_kind_check;
alter table integration_route add constraint integration_route_scope_kind_check
  check (scope_kind in ('default', 'slack_channel', 'linear_team', 'jira_project', 'sentry_project'));

create table sentry_credential (
  connection_id    uuid primary key references integration_connection (id) on delete cascade,
  organization_id  uuid not null references organization (id),
  -- v2 sealed box; '' once revoked (a disconnect clears it).
  sealed_value     text not null,
  keypair_id       text,
  -- The last four characters, so an administrator can tell two tokens apart. Never more.
  last4            text not null,
  created_by_principal_id uuid references principal (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- The rate cap (at most N alert-created tasks per connection per hour) counts this source's
-- recent ledger rows; received_at is already indexed, this narrows it to Sentry's.
create index intake_delivery_sentry_received_at_idx
  on intake_delivery (received_at) where source = 'sentry';
