# ADR-0025: M8 integrations borrow credentials from Vercel Connect and own their intake

- Status: Proposed
- Date: 2026-09-25

## Context

M8 lets work reach the factory from where it is already described: schedules, cron-triggered tasks, Slack, Linear, Jira, and API/webhook intake (`research/direction-change/PLAN.md` §M8).

## Decision

- §1 — Provider credentials come from Vercel Connect: Slack and Linear use their managed connectors; Jira uses a Custom OAuth connector against an Atlassian app we register.
- §2 — A Windkeel organization maps to a Connect installation, not a connector: One connector per provider; the `installationId` is stored on the organization's integration row and passed on every `getToken`.
- §3 — GitHub stays on our own App and ingress: M6's App, ADR-0009's scope and `docs/webhook-ingress.md` are unchanged.
- §4 — The intake is ours, whatever carries the webhook: Every integration lands on an ingress route that verifies a signature before parsing and records the delivery in the same transaction as the work it causes — M6's contract.
- §5 — Handlers answer 5xx only when a retry can help: Connect retries 5xx and nothing else, so a transient database failure is a 503 and a malformed or ignored event is a 2xx with the reason recorded.
- §6 — Schedules, cron and API/webhook intake need no integration platform: Schedules are Vercel Cron plus Workflow; API/webhook intake is M7's `/v1` API (ADR-0023) with a trigger on it.
- §7 — Accepted only after a one-day spike: answers:

## Consequences

- No provider secrets in ingress's environment beyond what M6 already has, **except Jira's webhook secret** (`WINDKEEL_JIRA_WEBHOOK_SECRET`; see the 2026-09-25 amendment below).
- Our integrations depend on a Vercel team-level product.
- Jira is the odd one out: Connect for tokens, our own webhook registration and verification.
- A trigger hop adds latency and a second signature to reason about; the delivery table, not Connect's dashboard, is where an operator looks.

**Later changes** (full text in Background):

- Amendment, 2026-09-25 — Jira's webhook secret is a provider secret ingress holds
- As built, 2026-09-25 (M8-10, #302)
- Amendment, 2026-10-21 — Sentry (#389): a sealed token, and a client secret ingress holds

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Proposed
- Date: 2026-09-25
- Milestone: 8 (Automations and integrations)

### Context

M8 lets work reach the factory from where it is already described: schedules, cron-triggered
tasks, Slack, Linear, Jira, and API/webhook intake (`research/direction-change/PLAN.md` §M8). The
plan already fixes the intake's shape — it is M6's, reused: signature before parse, parse before
database, delivery recorded in the same transaction as the work it causes, every ignored event
answering with a reason.

What was open is the plumbing under three of the six: who holds each provider's OAuth client, who
stores and refreshes tokens per tenant, and who receives the provider's webhooks. Building that per
provider is most of the work in an integration and none of its value.

[ADR-0020](0020-the-control-plane-is-vercel-end-to-end.md) put the control plane on Vercel end to
end. [ADR-0024](0024-tenancy-is-account-organization-principal-and-supabase-auth-only-signs-people-in.md)
§2 says an automation cannot authenticate as a person.

**Vercel Connect** (GA, docs of 2026-09-18) does the plumbing:

- **Outbound.** `getToken(connector, { installationId, subject, scopes })` returns a short-lived,
  refreshed provider token. The caller authenticates with the deployment's Vercel OIDC token, so no
  provider secret is in our environment. `subject: { type: 'app' }` is a service identity — the
  thing ADR-0024 §2 asks for.
- **Multi-tenant.** One connector holds many *installations* — one per Slack workspace, GitHub org,
  Linear workspace. A missing one throws `ConnectorInstallationRequiredError`, which is a
  "connect your workspace" state, not a 500.
- **Inbound ("triggers").** Connect verifies the provider's signature and forwards to up to three
  destinations per connector, adding a **Vercel OIDC bearer token** in place of the provider's
  signature. `createConnectWebhookVerifier` (`@vercel/connect/chat`) checks it against
  `VERCEL_PROJECT_ID` and `VERCEL_TARGET_ENV`, fails closed, and gives no nonce or deduplication.
  Connect does **not** map an inbound event to its installation; the receiver must. Slack, Teams and Linear (`Issue`, `Comment`) have triggers.
  **Jira does not** — its catalog entry lists OAuth and MCP only.
- **Delivery.** Retries only on 500/502/503/504, up to three attempts. The dashboard shows
  aggregate trigger metrics, **not a per-event delivery log**.
- **Ownership.** Slack, GitHub and Linear are *Vercel Managed*: Vercel registered the OAuth app.
  Custom OAuth is *Customer Managed*: we register it, Connect stores and exchanges.
- **Cost.** $3 per 1,000 token requests on Pro.

Alternatives considered:

- **Build it ourselves**, as M6 did for GitHub. Correct, and three times the OAuth, token storage
  and rotation code M6 needed once.
- **Nango** — open source, self-hostable, hundreds of providers, OAuth + webhooks + syncs, our
  branding. The strongest alternative; another service to run or pay for, outside ADR-0020.
- **Merge.dev ticketing** — one normalised API over Jira, Linear, GitHub Issues and more. Attractive
  for intake breadth; costly, and a lowest-common-denominator ticket loses what we parse for.
- **Pipedream Connect, Paragon** — embedded-iPaaS; heavier than an intake needs.
- **Composio, Arcade** — agent tool-calling; the wrong direction for intake.

### Decision

1. **Provider credentials come from Vercel Connect.** Slack and Linear use their managed
   connectors; Jira uses a Custom OAuth connector against an Atlassian app we register. Code asks
   for a token when it needs one and never stores it.

2. **A Windkeel organization maps to a Connect installation, not a connector.** One connector per
   provider; the `installationId` is stored on the organization's integration row and passed on
   every `getToken`. Token requests use `subject: { type: 'app' }` unless an action must be
   attributable to a person.

3. **GitHub stays on our own App and ingress.** M6's App, ADR-0009's scope and
   `docs/webhook-ingress.md` are unchanged. Connect's GitHub connector is not used.

4. **The intake is ours, whatever carries the webhook.** Every integration lands on an ingress route
   that verifies a signature before parsing and records the delivery in the same transaction as the
   work it causes — M6's contract. For Slack and Linear what is verified is Connect's
   forwarding OIDC token; the event's provider tenant ID (Slack `team_id`, Linear
   `organizationId`) is then resolved to an organization through §2's mapping, and an unknown
   tenant is an ignored delivery with a reason; for Jira it is the webhook we register ourselves. Because Connect keeps no
   per-event log, **our delivery table is the only record of what arrived**, and it records ignored
   events with a reason exactly as GitHub's does.

5. **Handlers answer 5xx only when a retry can help.** Connect retries 5xx and nothing else, so a
   transient database failure is a 503 and a malformed or ignored event is a 2xx with the reason
   recorded.

6. **Schedules, cron and API/webhook intake need no integration platform.** Schedules are Vercel
   Cron plus Workflow; API/webhook intake is M7's `/v1` API (ADR-0023) with a trigger on it.

7. **Accepted only after a one-day spike** answers:
   - Whose name and icon a customer sees installing the managed Slack and Linear apps. If it is
     Vercel's, decide between Custom OAuth connectors (our app, Connect's storage) and Nango.
   - Whether an installation's identity (workspace ID) is available to us at install time, so §2's
     mapping can be written without a second lookup.
   - That the forwarded request carries the provider's original event ID, which the delivery table
     needs for idempotency.
   - That a Slack slash command still gets its 3-second acknowledgement through the trigger hop.

### Consequences

- No provider secrets in ingress's environment beyond what M6 already has, **except Jira's webhook
  secret** (`WINDKEEL_JIRA_WEBHOOK_SECRET`; see the 2026-09-25 amendment below). ADR-0023 §1's secret
  surface grows by that one optional variable and no other.
- Our integrations depend on a Vercel team-level product. Moving off Vercel means moving
  credentials too; ADR-0020 already accepted that class of coupling.
- Jira is the odd one out: Connect for tokens, our own webhook registration and verification.
- A trigger hop adds latency and a second signature to reason about; the delivery table, not
  Connect's dashboard, is where an operator looks.

### Amendment, 2026-09-25 — Jira's webhook secret is a provider secret ingress holds

M8-8 (#300, PR #310) built Jira as Decision 4 and the Consequences describe it: tokens from a
Custom OAuth connector (`WINDKEEL_CONNECT_JIRA`), and a webhook Windkeel registers, refreshes and
verifies itself. Building it contradicted the first Consequence, which said no provider secret
would join ingress's environment. That line is amended above; this records why.

**Connect does not forward Jira events**, so there is no Connect OIDC bearer to verify
(Decision 4's route for Slack and Linear). Jira signs a dynamic webhook for an OAuth 2.0 (3LO) app
with a bearer JWT (HS256) keyed on **the app's client secret**. Whoever verifies the event must
hold that secret. So ingress holds `WINDKEEL_JIRA_WEBHOOK_SECRET`:

- **Optional and read per request.** Unset, `POST /api/intake/jira` answers 503 (Jira retries 5xx)
  and never accepts unverified; nothing else in the deployment reads it.
- **Never logged, echoed or stored**, and it cannot mint tokens on its own: a token needs a user's
  refresh token, which Connect holds.
- **Bounded replay.** A JWT claiming a lifetime over an hour is refused; a captured token replays at
  most that long, and each replay must also carry a fresh `X-Atlassian-Webhook-Identifier` to get
  past the delivery ledger. That residual risk is accepted.

This grows [ADR-0023](0023-control-plane-api-reads-direct-writes-intents-updates-resume-from-a-cursor.md)
§1's secret surface for ingress — "the webhook secret and the GitHub App credentials" — by exactly
one optional variable. §1's rule stands for everything else: an endpoint that would need a model key
or `VERCEL_TOKEN` is still in the wrong process. If Connect gains Jira triggers, verify Connect's
forward instead and delete the variable.

Two further consequences of owning the webhook, from the same review:

- **Attribution is checked against the site.** Jira's webhook ids are per site and small, so they
  collide across tenants; an event is attributed to a connection only when `issue.self`'s origin is
  that connection's recorded site (or `self` names the cloud id directly). Otherwise it is an
  ignored `unknown_tenant` delivery.
- **Registration is serialised, and every webhook it registers is either recorded or deleted
  again** (wording corrected 2026-10-20, #313 — "does not orphan by design" overstated it: a
  registration whose record rolled back, a replaced webhook whose delete failed, and a disconnect
  that found the connection busy each left a webhook at Jira that no row recorded). One `ensure`
  per connection at a time (an advisory transaction lock). The new webhook is registered before the
  stale one is deleted, and recorded — with the stale one moved to `retired_webhook_ids` — before
  that delete is attempted; if the record does not commit, the new webhook is deleted again. A
  retired id is deleted on a later pass if its first delete fails. Disconnect deletes the webhooks
  at Jira as well as the row; a disconnect or route change that finds the connection busy marks it
  (`jira_webhook_dirty`), the holder re-runs when it finishes, and the hourly sweep reaps the rows
  and webhooks of disconnected connections. **Residual:** a process that dies between Jira
  accepting a registration and the record committing, or a compensating delete that also fails,
  still leaves one webhook only Jira knows of. It is logged with its ids. Jira's list call does
  not return a webhook's URL, so `ensure` cannot tell such an orphan from another deployment's
  webhook under the same Atlassian app, and it does not delete unrecorded webhooks it lists.

### As built, 2026-09-25 (M8-10, #302)

Milestone 8 is code complete on `m8-automations-integrations` (#293–#301, #294). This section
records every place the implementation departed from, or had to decide beyond, the Decision above.
The status stays **Proposed**: Decision 7's spike (M8-0, #292) has not run, and several of the
choices below are marked as waiting for what it finds. The end-to-end proof is
`test/e2e-m8-intakes.test.js`; the live proof is the checklist on #302.

**1. Verifying a Connect forward (Decision 4).** Built as decided — `createConnectWebhookVerifier`
from `@vercel/connect/chat`, behind `verifyConnectForward` in `src/integrations/vercel-connect.ts`,
the only file that imports `@vercel/connect` — with three departures:

- ~~It accepts tokens issued for **both `production` and `preview`**, not `VERCEL_TARGET_ENV` alone,
  so a preview deployment can receive a connector's trigger (the live checklist needs this).~~
  **Amended 2026-10-16:** it accepts tokens for **this deployment's own environment only**
  (`VERCEL_TARGET_ENV`, else `VERCEL_ENV`; neither set refuses every forward), and pins `owner_id`
  when `WINDKEEL_CONNECT_OWNER_ID` or a `team_…` `VERCEL_TEAM_ID` is set. Accepting both meant a
  production deployment trusted a token minted by any *preview* deployment of the project — readable
  by any code a branch push deploys — and because the bearer is the whole authentication and Slack
  and Linear take the tenant from the body, that token could forge events into any tenant on
  production. A preview deployment still receives its own environment's triggers. Residual: any code
  running in *this* environment of the project can mint an acceptable token (Connect documents no
  audience or subject unique to its forwarder to pin), and a preview deployment wired to
  production's database is outside what this check can protect.
- **The bearer is not bound to the body.** The verifier reads only `Authorization`; the OIDC token
  says "Connect, for this project", not "this event". Replay is bounded elsewhere: the delivery
  ledger (a repeated Slack `trigger_id`/`event_id` or `Linear-Delivery` is a duplicate) and, for
  Linear, a 5-minute `webhookTimestamp` window. The residual risk — a captured token re-sent with a
  fresh event body within its lifetime — is accepted and noted for #292 to measure.
- **It never throws**: every failure (no header, no `VERCEL_PROJECT_ID`, the SDK failing to load)
  is a `401`. Verification that could be skipped by making it crash is not verification.

**2. Tenant resolution is ours, and is written at connect time (Decisions 2, 4, 7).** As decided,
Connect does not say which installation an event belongs to. `integration_connection` stores the
provider's own tenant id (`external_tenant_id`: Slack `team_id`, Linear `organizationId`, Jira
cloud id) beside the Connect `installation_id`, learned **when an operator connects the
installation** (`POST /v1/integrations` → `describeInstallation` → `getTokenResponse().tenantId`,
token discarded). Every event is resolved with `resolveConnection(provider, tenantId)`; an unknown
tenant is an ignored `unknown_tenant` delivery. One workspace belongs to one organization at a time
(`409 tenant_claimed`). **Departure:** there is no install callback — connecting is a manual second
step until #292 answers whether the workspace id is available at install time. Routing to a
repository (`integration_route`, by Slack channel / Linear team / Jira project, else a `default`)
is beyond the Decision; a disabled specific route is an ignored `route_disabled`, never a
fall-through to the default.

**3. Jira's webhook secret.** Recorded in the amendment above: `WINDKEEL_JIRA_WEBHOOK_SECRET` is the
one provider secret ingress holds (HS256 JWT under the Atlassian app's client secret, bounded to a
one-hour lifetime). Registration is ours too, and Jira's webhook JQL cannot filter on labels, so the
filter is `project IN (…)` over enabled routes — **every visible project for a `default` route,
capped at 200** — and the label is checked on arrival. Events are attributed to a site only when
`issue.self`'s origin matches the recorded site.

**4. The reply seam (Decision 4's "answering with a reason").** M6's pipeline answered with its own
`{ok, intent, reason}` body. Slack needs the slash command's ephemeral message in the HTTP answer,
and a signed webhook's contract is `202 {taskId, engineeringRunId}`, so a source can now set the
answer inside its transaction (`tx.reply(status, body)` → `IntakeResponse.reply`, sent by
`wireResponse`). The ledger row and the task are still one transaction; only the wire body is the
source's (docs/webhook-ingress.md "The response seam").

**5. The notifier seam — how a source hears back.** Not in the Decision. GitHub keeps answering
from its stage handlers (ADR-0009 §4). Every other source registers a `SourceNotifier` keyed by
`source_type`, called by `advanceRun` **in the flow function** after a transition commits
(`src/intake/notifiers.ts`). It is bounded (10 s, with an abort signal), never fails or stalls a
run, and is **idempotent on the committed transition's id** (`outcome.transitionId`): a replayed
workflow step gets the same `run_state_transition` row back (`advanceRun`'s replay rule — the
in-memory fake store now applies the same rule), so it posts once, while a genuine second entry
into a state posts again. Notifiers are registered only by `registerDeploymentNotifiers`, each
behind its `WINDKEEL_CONNECT_*`, never from `stage-wiring.ts`.

**6. The `started` outcome.** Also new. A notifier hears two kinds of outcome: `state` (a terminal
state, `WAITING_FOR_HUMAN`, `WAITING_FOR_APPROVAL`) and `started` (the run's first move out of
`CREATED`). `started` exists for Slack: the thread root must exist before any outcome, and posting
it from the ingress would put a Slack call inside Slack's 3-second window and race the notifier. So
**the Slack intake makes no Slack or Connect call at all**; the root is created by the notifier, in
order, with an atomic claim so there is only ever one. Linear and Jira post their start comment
from the intake (bounded at 5 s, after commit) and ignore `started`.

**7. Per-source decisions.**

- **Slack** — no workspace-wide default: only a `slack_channel` route starts work, because anyone
  who can post in a mapped channel can start work there, and in any granted repository by naming
  it. Ignored mentions are recorded but not answered in Slack (an event has no ephemeral channel).
- **Linear** — labels matched by **name** from `data.labels`; a payload with only `labelIds` is an
  ignored `labels_unavailable` until #292 confirms what Connect forwards. The route is resolved
  before the label (the trigger label belongs to the route). Linear's own retries mostly fall
  outside the replay window, so a failed enqueue is healed by the **stranded-run sweep** (a run
  still `CREATED` with no binding after 10 minutes is re-enqueued), not by the retry. Duplicate
  detection of `commentCreate` ids is unverified until #292.
- **Re-labelling** mirrors GitHub for Linear and Jira through one helper (`retriggerExistingTask`):
  a `CREATED` run is re-enqueued, a live run is `already_tasked`, a finished task gets a fresh run.
- **Schedules** (Decision 6) — a Vercel cron tick every five minutes (`/api/schedules`) turns due
  slots into tasks through the intake pipeline, and the run is Workflow's like any other; missed slots
  **coalesce** into one task with the rest recorded `coalesced`; and a schedule **pauses while the
  PR its previous run opened is unmerged** (`previous_run_in_flight`) — a product decision recorded
  in docs/schedules.md.
- **Signed webhooks and the API** (Decision 6) — per-endpoint secrets are derived from one
  `WINDKEEL_WEBHOOK_SIGNING_KEY` and never stored (ADR-0023's 2026-09-25 amendment); `POST /v1/tasks`
  takes an `Idempotency-Key`, scoped per principal, recorded in the same ledger.
- **Who a task belongs to** — every automation creates work as an organization principal of kind
  `token`: a per-purpose **system actor** (`getSystemActor`: `slack`, `linear`, `jira`, `webhook`,
  `schedules`) or, through the API, a **service principal**. Never a person (ADR-0024 §2; its own
  "As built" section records the service-principal departures).

### Amendment, 2026-10-21 — Sentry (#389): a sealed token, and a client secret ingress holds

Sentry joins as a fourth provider (`provider = 'sentry'`, routes `sentry_project`, the `sentry`
system actor; migration `0046_sentry_integration.sql`). Two things in it bend this ADR, each
recorded here and decided elsewhere:

- **§1, "we store no provider token", has one exception.** Vercel Connect cannot hold a Sentry
  integration credential, so the token the Sentry post-back comments with is stored **sealed**
  with ADR-0026's box — opened only by the flow function's notifier. The spike, the terms and the
  limits are [ADR-0034](0034-sentry-tokens-are-stored-sealed-an-exception-to-adr-0025.md). Slack,
  Linear and Jira are unchanged.
- **Ingress holds one more provider secret**, `WINDKEEL_SENTRY_CLIENT_SECRET`, on exactly the terms of
  the Jira amendment above: Sentry signs its integration webhooks (`Sentry-Hook-Signature`, hex
  HMAC-SHA256 of the raw body) with the integration's client secret, so the verifier must hold it.
  Optional and read per request; unset ⇒ every delivery is `503 integration_misconfigured`; used
  only to verify. Sentry signs the body only, so `Sentry-Hook-Timestamp` and `Request-ID` are
  not authenticated: the 5-minute window and the delivery ledger stop accidental redeliveries,
  not a deliberate replay of a captured body with fresh headers. What bounds that is the body
  itself — one task per Sentry issue (`source_reference`), so a replay records `duplicate`.

Two Sentry-specific rules, because an alert is not a ticket somebody wrote: the trigger is the
alert **rule's name** (it must carry the route's `trigger_label`, default `windkeel`) rather than a
label, and an alert storm is bounded — one task per Sentry issue, and at most 20 new tasks per
connection per hour (`rate_limited`). Alert text is untrusted and quoted as data; it can never
become an acceptance criterion, so a human approves every Sentry task's criteria (ADR-0012).
