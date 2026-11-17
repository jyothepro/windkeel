-- The Jira webhooks Orqon registers for itself (M8-8, ADR-0025 Decision 1 and 4).
--
-- Vercel Connect has no Jira triggers, so for Jira we register, verify and refresh the webhook
-- ourselves through Jira's dynamic webhook API (`POST /rest/api/3/webhook`, OAuth 2.0 (3LO) apps).
-- Jira expires a dynamic webhook 30 days after it was registered or last refreshed; the hourly sweep
-- (`jira-webhook-refresh`) extends it and re-registers one Jira has dropped.
--
-- One row per Jira connection. `webhook_ids` are Jira's ids for what we registered on that site;
-- `jql` is the filter they were registered with, so a change of routes is noticed as a mismatch.
-- `site_url` is the site's base URL (from `accessible-resources`), used to tell two sites apart
-- when an inbound event's `matchedWebhookIds` alone would be ambiguous (ids are per site).
--
-- **No credential is stored here.** The webhook's JWT is signed with the Atlassian app's client
-- secret, which is configuration, not data.
--
-- **No object here is schema-qualified** (ADR-0024 §11).

create table jira_webhook (
  connection_id      uuid primary key references integration_connection (id) on delete cascade,
  cloud_id           text not null,
  site_url           text,
  webhook_ids        bigint[] not null,
  jql                text not null,
  expires_at         timestamptz not null,
  last_refreshed_at  timestamptz,
  last_error         text
);

create index jira_webhook_cloud_id_idx on jira_webhook (cloud_id);
create index jira_webhook_webhook_ids_idx on jira_webhook using gin (webhook_ids);
