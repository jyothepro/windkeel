-- Which provider workspace belongs to which organization, and which repository its work goes to
-- (ADR-0025 §2).
--
-- An organization maps to a Vercel Connect *installation* — one Slack workspace, one Linear
-- workspace, one Jira site — not to a connector. The installation id is what every `getToken` call
-- passes; the provider's own tenant id (Slack `team_id`, Linear `organizationId`, Jira cloud id) is
-- what an inbound event carries, because Connect does not say which installation a forwarded event
-- belongs to (ADR-0025 §4). So both are stored, and the tenant id is the one looked up on intake.
--
-- **No provider credential is stored here, or anywhere.** Tokens are asked for when needed and
-- never kept (ADR-0025 §1).
--
-- **No object here is schema-qualified** (ADR-0024 §11).

create table integration_connection (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references organization (id),
  provider                 text not null check (provider in ('slack', 'linear', 'jira')),
  -- The Vercel Connect installation this organization's tokens are requested against.
  installation_id          text not null,
  -- The provider's own tenant id, which is what an inbound event names.
  external_tenant_id       text not null,
  external_tenant_name     text,
  status                   text not null default 'active' check (status in ('active', 'disconnected')),
  created_by_principal_id  uuid references principal (id),
  created_at               timestamptz not null default now(),
  disconnected_at          timestamptz
);
-- One provider workspace belongs to one organization at a time. A disconnected row keeps its
-- history and frees the tenant for another organization.
create unique index integration_connection_active_tenant_idx
  on integration_connection (provider, external_tenant_id) where status = 'active';
create index integration_connection_organization_id_idx on integration_connection (organization_id);

-- Where a connection's work goes. A `default` route catches everything a more specific scope (a
-- Slack channel, a Linear team, a Jira project) does not. The repository must be granted to the
-- connection's organization; that is checked when the route is written, because a grant is a row
-- an administrator can remove later and the intake re-checks it then.
create table integration_route (
  id             uuid primary key default gen_random_uuid(),
  connection_id  uuid not null references integration_connection (id) on delete cascade,
  scope_kind     text not null check (scope_kind in ('default', 'slack_channel', 'linear_team', 'jira_project')),
  scope_value    text,
  repository_id  uuid not null references repository (id),
  -- The label (or reaction, or keyword) that marks a provider item as work for the factory.
  trigger_label  text not null default 'orqon',
  enabled        boolean not null default true,
  created_at     timestamptz not null default now()
);
create unique index integration_route_scope_idx
  on integration_route (connection_id, scope_kind, coalesce(scope_value, ''));

-- `integrations.manage` joins the built-in admin role. Written to be a no-op when another migration
-- has already added it (M8-2 adds the same permission).
update access_role
   set permissions = permissions || array['integrations.manage'], updated_at = now()
 where key = 'admin' and account_id is null and not ('integrations.manage' = any (permissions));
