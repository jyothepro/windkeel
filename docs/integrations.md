# Integrations: every way work reaches the factory (operator guide)

Milestone 8 lets work reach Windkeel from where it is already described. This page is the operator's
guide to all of it: the six M8 intakes and Sentry alerts (#389) beside the GitHub label, the
variables that switch each on,
how a provider workspace is connected and routed, and — the part to read before connecting
anything — **who can start work from each source**. The decision behind it is
[ADR-0025](adr/0025-m8-integrations-borrow-credentials-from-vercel-connect-own-the-intake.md) (and its
"As built" section for where the code departed from it). Wire contracts live beside this page:
[webhook-intake.md](webhook-intake.md) (signed webhooks, `Idempotency-Key`),
[schedules.md](schedules.md) (cron), [control-plane-api.md](control-plane-api.md) (every `/v1`
endpoint), [webhook-ingress.md](webhook-ingress.md) (the intake pipeline itself).

## The eight front doors

| Source | Arrives at | Verified by | Task `source_type` · actor | Answers the source with |
| --- | --- | --- | --- | --- |
| GitHub issue labelled `windkeel` (M6) | `POST /api/webhook` | GitHub App HMAC (`GITHUB_WEBHOOK_SECRET`) | `github_issue` · none (the App) | Issue comments from the stage handlers |
| Slack `/windkeel` or `@Windkeel` in a mapped channel | `POST /api/intake/slack` (Connect trigger) | Vercel Connect OIDC bearer | `slack` · `slack` system actor | Ephemeral "Starting…"; thread root on `started`, outcome (draft-PR link) in the thread |
| Linear issue labelled `windkeel` | `POST /api/intake/linear` (Connect trigger) | Vercel Connect OIDC bearer + 5-min timestamp window | `linear` · `linear` system actor | "Windkeel started" comment; outcome comment with the PR link |
| Jira issue labelled `windkeel` | `POST /api/intake/jira` (our registered webhook) | HS256 JWT under `WINDKEEL_JIRA_WEBHOOK_SECRET` | `jira` · `jira` system actor | ADF acknowledgement; ADF outcome comment with the PR link |
| Sentry alert whose rule is named `windkeel …` (#389) | `POST /api/intake/sentry` (the Sentry integration's webhooks) | Hex HMAC-SHA256 of the body under `WINDKEEL_SENTRY_CLIENT_SECRET` + 5-min `Sentry-Hook-Timestamp` window | `sentry` · `sentry` system actor | Comments on the Sentry issue: started, approval request, "Verifying…", the verdict with the draft PR (see [Sentry](#sentry)) |
| Signed webhook | `POST /api/intake/webhook/{endpointId}` | HMAC-SHA256 with the endpoint's derived `whsec_` secret, 5-min window | `webhook` · `webhook` system actor | `202 {taskId, engineeringRunId}` |
| API | `POST /v1/tasks` (optional `Idempotency-Key`) | An `orq_` token (a service principal's, for an automation) | `api` · the calling principal | `202 {accepted, taskId, engineeringRunId, enqueued}` |
| Schedule | Vercel cron → `/api/schedules` every 5 min | `CRON_SECRET` | `schedule` · `schedules` system actor | Nothing to answer; the ledger row per slot |

Every M8 source goes through one pipeline (`src/intake/pipeline.ts`, M6's contract): verify before
parse, parse before the database, **one `intake_delivery` row in the same transaction as the task it
causes**, every ignored event recorded with its reason, and a 5xx only when a retry can help. When
something "did nothing", the ledger says why:

```sql
select received_at, source, delivery_key, intent, reason, engineering_task_id
  from intake_delivery order by received_at desc limit 50;
```

Every task an automation creates names its creator in `engineering_task.created_by_principal_id`: an
organization principal of kind `token` — a built-in **system actor** (`principal.system_purpose` =
`slack` / `linear` / `jira` / `sentry` / `webhook` / `schedules`) or a **service principal** calling the API.
Never a person (ADR-0024 §2). `test/e2e-m8-intakes.test.js` proves each row of this table end to
end, from the request to a verified draft PR and back to the source.

## Who can start work from each source

Read this before connecting anything. Starting work spends money and opens pull requests, so each
source's reach is the set of people who can do the triggering thing there.

| Source | Who can start work | In which repositories | How to narrow it |
| --- | --- | --- | --- |
| GitHub | Anyone who can label an issue `windkeel` in a repository the App is installed on | That repository | Repository permissions; ADR-0009 |
| Slack | **Anyone who can post in a mapped channel** — including guests in it | The channel's repository, **or any repository granted to the organization, by naming it** (`/windkeel owner/repo …`) | Map only channels whose members you would give that power. There is deliberately no workspace-wide default. Private channels must invite @Windkeel |
| Linear | Anyone who can add the route's trigger label to an issue in a routed team | The team route's repository; with a `default` route, **every team** in the workspace | Prefer `linear_team` routes to a `default`; change the `triggerLabel` |
| Jira | Anyone who can add the trigger label to an issue in a routed project | The project route's repository; with a `default` route, **every project the app can see** (up to 200) | Prefer `jira_project` routes; change the `triggerLabel` |
| Sentry | **Anyone who can create or rename an alert rule** in a routed Sentry project — the rule's name is the opt-in (`windkeel …`); and, once a rule is armed, anyone whose traffic makes the application throw the error it watches | The project route's repository; with a `default` route, **every project in the Sentry organization** | Prefer `sentry_project` routes; keep `triggerLabel` a word (never `*` unless every alert should be work); the rate cap bounds a storm at 20 tasks per connection per hour |
| Signed webhook | **Anyone holding the endpoint's secret** — no Windkeel identity is involved | That endpoint's one repository | Rotate (`POST …/rotate`) to revoke every earlier secret at once; disable or delete the endpoint |
| API | Any principal with `runs.write` in the organization (`member` and up) | Any repository granted to the organization | Give automations a service principal with its own token, revocable without touching a person |
| Schedule | Whoever holds `schedules.manage` (admin) defines it; after that it runs unattended | The schedule's repository | Disable or delete the schedule |

A repository reaches an organization **only** through `repository_grant` (ADR-0024 §2): no route,
endpoint or schedule can name one that is not granted (`422 repository_not_granted`), and a grant
removed later turns that source's next event into an ignored delivery with the reason recorded
(never a task).

## The model

**Credentials come from Vercel Connect, and we store none.** Each provider has one Connect
*connector* on the Vercel team. Each customer workspace is one Connect *installation* of that
connector — one Slack workspace, one Linear workspace, one Jira site. Code asks Connect for a
short-lived token when it needs one (`subject: { type: 'app' }`, never a person) and drops it
after the request. **Sentry is the one exception** (ADR-0034): Connect does not carry it, so its
token is stored sealed with the BYOK box (ADR-0026) — see [Sentry](#sentry).

**An organization holds a connection; a connection has routes.**

| Table | One row is | Key facts |
| --- | --- | --- |
| `integration_connection` | One provider workspace connected to one organization | `provider` (`slack`/`linear`/`jira`/`sentry`), the Connect `installation_id`, the provider's own `external_tenant_id` (Slack `team_id`, Linear organization id, Jira cloud id, Sentry installation uuid) and its name. `status` is `active` or `disconnected`. |
| `sentry_credential` | The Sentry token one Sentry connection comments with — **sealed** (migration 0046, ADR-0034) | The one provider credential Windkeel stores; see [Sentry](#sentry). Deleted on disconnect. |
| `integration_route` | Where some of that workspace's work goes | `scope_kind` + `scope_value`, a `repository_id`, the `trigger_label` that marks an item as work (default `windkeel`), and `enabled`. |

**One workspace belongs to one organization at a time.** A second organization connecting a
workspace that is already active elsewhere is refused with `409 tenant_claimed`. Disconnecting
frees it; the old row stays as history.

**A route may only name a repository granted to the organization** (`repository_grant`, ADR-0024
§2). Anything else is `422 repository_not_granted`.

## How a route picks a repository

An inbound event carries the provider's tenant id and, usually, a narrower scope: a Slack channel,
a Linear team, a Jira project. The intake asks two questions:

1. `resolveConnection(db, provider, tenantId)` — the active connection for that workspace, or
   none. None means the event is ignored with a reason (the workspace is not connected).
2. `resolveRoute(db, connectionId, { scopeKind, scopeValue })` — the route naming exactly that
   scope; else the connection's `default` route; else none. None means ignored with a reason (no
   route).

| Provider | Specific scope | `scope_value` |
| --- | --- | --- |
| Slack | `slack_channel` | Channel id, e.g. `C0123ABCD` |
| Linear | `linear_team` | Team key or id |
| Jira | `jira_project` | Project key, e.g. `ENG` |
| Sentry | `sentry_project` | Project slug, e.g. `checkout-web` |

A connection has at most one route per scope and one `default`. **A disabled route is still the
answer** — the intake records the event as ignored because the route is disabled, instead of
falling through to the default and sending a switched-off channel's work somewhere else.

## Environment

All optional, and read on the request that needs them, not when a function starts. An unset one
disables only what it names — **unset is "that integration is off", never a boot error**
(`windkeel doctor` and the deployed preflight report each as on/off, check `integrations`).
**Migrations 0023–0028** (`npm run db:migrate`) must be applied before any of it works:
`intake_delivery`, service principals, `integration_connection`/`integration_route`, `schedule`,
`webhook_endpoint`, `jira_webhook` — and **0038** (`jira_webhook.retired_webhook_ids`,
`jira_webhook_dirty`) before Jira webhook reaping (#313). Sentry needs **0046**
(`0046_sentry_integration.sql`: the `sentry` provider, `sentry_project` routes, `sentry_credential`).

| Variable | Read by | What | Unset means |
| --- | --- | --- | --- |
| `WINDKEEL_CONNECT_SLACK` | ingress (Connect tokens; enqueues ignored-mention feedback), **flow function** (registers the Slack notifier; posts the feedback) | The Slack connector's uid, e.g. `slack/windkeel` | Slack intake still records deliveries, but nothing is ever posted in Slack; token requests answer `503 integration_misconfigured` |
| `WINDKEEL_CONNECT_LINEAR` | ingress, **flow function** (Linear notifier) | The Linear connector's uid | No start or outcome comments; connecting answers 503 |
| `WINDKEEL_CONNECT_JIRA` | ingress (acknowledgement, webhook registration), **flow function** (Jira notifier) | The Jira Custom OAuth connector's uid | No comments and no webhook registration; connecting answers 503 |
| `WINDKEEL_JIRA_WEBHOOK_SECRET` | ingress | The Atlassian OAuth 2.0 app's **client secret**, which Jira signs its webhook JWTs with (see [Jira](#jira)) | `/api/intake/jira` answers 503 to everything (Jira retries 5xx) |
| `WINDKEEL_SENTRY_CLIENT_SECRET` | ingress | The Sentry integration's **client secret**, which Sentry signs `Sentry-Hook-Signature` with (see [Sentry](#sentry)) | `/api/intake/sentry` answers `503 integration_misconfigured` to everything (Sentry retries) |
| `WINDKEEL_CONNECT_SENTRY` | **flow function** (registers the Sentry notifier) | Switches the Sentry post-back on. Any non-empty value (e.g. `sealed`); the name is reserved for a Connect connector uid should Connect ever carry Sentry (ADR-0034) | No comments on Sentry issues; the intake still works |
| `WINDKEEL_SECRET_PUBLIC_KEY` / `WINDKEEL_SECRET_PRIVATE_KEY` | ingress (seals the Sentry token) / **flow function** (opens it) | The ADR-0023 §9 / ADR-0026 key pair (`windkeel-admin secrets keygen`) | Connecting Sentry *with a token* is `503 secrets_disabled`; without the private key the notifier skips (`no_credential`) |
| `WINDKEEL_PUBLIC_URL` | ingress, sweep | This deployment's public `https://` base URL; the Jira webhook is registered at `{WINDKEEL_PUBLIC_URL}/api/intake/jira` | Registration fails into `jira_webhook.last_error` |
| `WINDKEEL_WEBHOOK_SIGNING_KEY` | ingress | ≥ 32 bytes of random key every endpoint's `whsec_` secret is derived from (never stored per endpoint) | Creating or rotating an endpoint is `503 webhook_signing_unconfigured`; every delivery is 503 |
| `WINDKEEL_CONSOLE_URL` | ingress, **flow function** | The console's base URL: run links in Slack, Linear, Jira and Sentry messages (`{WINDKEEL_CONSOLE_URL}/runs/{id}`), and the CLI's device login | Messages show the run id instead of a link |
| `CRON_SECRET` | ingress (`/api/schedules`, `/api/sweep`) | Vercel's cron bearer | Both cron routes refuse every call (fail closed): no schedule fires |

Connect authenticates the deployment with its Vercel OIDC token (`VERCEL_OIDC_TOKEN`, set by
Vercel). The project and environment must be linked to each connector; if not, token requests
fail with `integration_misconfigured`. Verifying a Connect-forwarded webhook
(`verifyConnectForward`) needs `VERCEL_PROJECT_ID` and `VERCEL_TARGET_ENV` or `VERCEL_ENV`, which
Vercel sets; it accepts only tokens issued for **this deployment's own environment** (production
accepts production, never preview) and fails closed without a project id or an environment. Set
`WINDKEEL_CONNECT_OWNER_ID` to your Vercel team id (`team_…`) to pin the token's `owner_id` as well; a
`team_…` `VERCEL_TEAM_ID` is used when it is unset.

**The notifiers run in the flow function, not the ingress.** They are called from `advanceRun`,
registered by `registerDeploymentNotifiers` (`src/factory/workflow/deployment-notifiers.ts`) —
each only when its `WINDKEEL_CONNECT_*` is set in the flow function's environment. In today's
single-project layout that is the same project as the ingress; if they are ever split, set the
`WINDKEEL_CONNECT_*` and `WINDKEEL_CONSOLE_URL` on both.

## Status updates: the verifier's verdict

Windkeel's edge is the independent verifier (ADR-0004): a fresh sandbox re-checks every candidate, and
there is no path around it (ADR-0029). So what goes back to Slack, Linear, Jira and Sentry is **the
verdict**, not "a PR was opened" (#389):

| Moment | Seam outcome (`src/intake/notifiers.ts`) | What the source hears |
| --- | --- | --- |
| The run is picked up | `started` | Slack: the thread root; Sentry: "Windkeel picked up this alert…"; Linear and Jira already acknowledged at intake |
| The run first enters `VERIFYING` | `progress` — fired on every entry; each notifier posts **at most one per run** (Slack/Sentry: claim `verifying:<runId>`; Linear: comment id from the run; Jira: marker `windkeel-run <runId> verifying`) | "Verifying in an independent sandbox…" |
| `WAITING_FOR_HUMAN` | `state`, with `verdict` | Passed: "Verified ✓ N/N criteria · draft PR … · run …". Otherwise: "needs a human — Not verified: k of N criteria failed" or "No verification result" |
| `FAILED`, `MAX_REPAIR_ATTEMPTS_REACHED` | `state`, with `verdict` | "Not verified: k of N criteria failed" (or "No verification result" when it never verified) plus the relayed reason |
| `WAITING_FOR_APPROVAL`, `CANCELLED`, `COMPLETED` | `state` | As before |

The verdict (`verdictForRun`, `src/intake/verdict.ts`) is the latest **completed** verification's
`verdict` and the **counts** in its `risk_summary` (criteria satisfied/unsatisfied, blocking
findings) against the task's criteria — numbers only. No finding title, check output or summary
text is ever relayed: like a transition's reason (`relayableReason`, ORQ-12), all of that is text the
sandbox produced. "Verified" appears only when the verdict is `pass`/`warn` with no criterion failed;
no message says "ready" before the verdict, and none says an issue is "fixed". A notifier that has
nothing to say on `progress` returns on it.

## Connecting a workspace (the manual path)

1. In the Vercel dashboard, install the provider's connector into the customer's workspace. Note
   the installation id Connect shows.
2. Register it with the organization. The deployment asks Connect who the installation is
   (`getTokenResponse`), stores the tenant id and name, and discards the token:

   ```bash
   windkeel integration connect slack <installation-id>
   # or: POST /v1/integrations {"provider":"slack","installationId":"<installation-id>"}
   ```

   **Treat the installation id as a claim ticket.** Nothing ties a Connect installation to the
   organization that names it: the first organization to register an id receives that
   workspace's events. Give the id only to the workspace's own Windkeel admin, or register it
   yourself, and never paste it into a shared channel or ticket. Once a workspace has been
   connected, a later claim by a different organization is refused: from another account it needs
   the operator to remove the old `integration_connection` row first, and from the same account it
   needs `integrations.manage` through an account role.

3. Give its work somewhere to go. A default route first, then any narrower ones:

   ```bash
   windkeel integration route add <integration-id> --repo <repository-id>
   windkeel integration route add <integration-id> --repo <other-repository-id> --scope slack_channel --value C0123ABCD
   ```

4. Check it: `windkeel integration list`.

Steps 2–4 can also be done in the console, under **Settings → Integrations**. A connection's
`createdByPrincipalId` (who connected it — an id, never a credential) is what it shows as
"connected by".

`windkeel integration disconnect <id>` marks it disconnected; `windkeel integration route rm <id>
<route-id>` removes a route. `PATCH /v1/integrations/{id}/routes/{routeId}` changes a route's
repository, label or `enabled`; its scope is its identity and does not change.

Writes need `integrations.manage` (in the `admin` role and preset, and — like the other admin
permissions — not granted to a CLI login unless `--admin` is asked for). Listing needs `runs.read`.

**The two lists differ on purpose.** `GET /v1/integrations` needs only `runs.read` — a member may
see which workspaces feed the organization and where their work goes. `GET /v1/webhook-endpoints`
needs `integrations.manage` — an endpoint id is half of what it takes to address one (the other
half is its secret), so listing them is an admin's view. The console mirrors this: the Integrations
tab is readable by members, the Webhook endpoints tab only by admins.

| Refusal | Means |
| --- | --- |
| `409 tenant_claimed` | Another organization holds that workspace. |
| `422 integration_not_connected` | Connect has no usable installation with that id (missing, revoked). |
| `422 tenant_unknown` | Connect did not say which workspace the installation is. |
| `422 repository_not_granted` | The route names a repository this organization has no grant for. |
| `409 route_exists` | That scope already has a route on this connection. |
| `503 integration_misconfigured` | This deployment cannot reach the connector: its `WINDKEEL_CONNECT_*` is unset, the connector does not exist, or the project/environment is not linked. |
| `503 integrations_disabled` | This deployment has no token source at all. |

An install callback that records the connection without step 2 depends on ADR-0025 §7's spike
(whether the workspace id is available at install time) and is not built yet.

## For code

Everything lives in `src/integrations/`, and **nothing outside it imports `@vercel/connect`**
(asserted by `test/integrations-token-source.test.js`).

- `ProviderTokenSource` — `getToken`, `describeInstallation`, `invalidate`. `VercelConnectTokenSource`
  in production, `FakeProviderTokenSource` in tests.
- `withProviderToken(source, req, fn)` — calls `fn(token)`, and on a provider 401 drops the cached
  token (`deleteTokenCacheEntry`) and retries once.
- Errors: `IntegrationNotConnected`, `IntegrationMisconfigured`, `IntegrationUnavailable`,
  `TenantClaimedError`, `RouteError`, `ProviderUnauthorized`.
- `verifyConnectForward(req)` / `createConnectForwardVerifier()` / `fakeConnectForwardVerifier()`
  for Connect-forwarded webhooks.

## Jira

Jira is the odd one out (ADR-0025 Consequences): **tokens come from Vercel Connect, but the webhook
is ours.** Connect's Jira entry has OAuth and MCP only, no triggers, so Windkeel registers its own
webhook on each connected site, keeps it alive, and verifies what arrives. Code:
`src/integrations/jira.ts` (REST calls, registration, JWT check), `src/integrations/jira-intake.ts`
(the intake source and the notifier), `src/integrations/adf.ts` (descriptions).

### What Atlassian documents (checked 2026-09-25)

| Fact | Source |
| --- | --- |
| OAuth 2.0 (3LO) apps register webhooks dynamically: `POST /rest/api/3/webhook` `{url, webhooks: [{jqlFilter, events, fieldIdsFilter}]}`, called as `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/webhook`. `GET` lists them, `DELETE` removes them, `PUT /rest/api/3/webhook/refresh` extends them. Scopes `read:jira-work` + `manage:jira-webhook`. | [Webhooks REST group](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-webhooks/), [Webhooks guide](https://developer.atlassian.com/cloud/jira/platform/webhooks/#registering-a-webhook-using-the-rest-api--for-connect-and-oauth-2-0-apps-) |
| A dynamic webhook **expires 30 days** after registration or refresh (and stays refreshable for 3 months after). At most **5 webhooks per app per user** on a site; one URL per app. | [Webhooks guide — Registration restrictions, Webhook expiration](https://developer.atlassian.com/cloud/jira/platform/webhooks/) |
| **Only a subset of JQL is supported**: `issueKey`, `project`, `issuetype`, `status`, `priority`, `assignee`, `reporter`, `issue.property`, `cf[id]` (epic only), with `=`, `!=`, `IN`, `NOT IN`. **`labels` is not supported.** | [Webhooks guide — Supported JQL queries](https://developer.atlassian.com/cloud/jira/platform/webhooks/) |
| **Authentication:** "Webhooks for OAuth 2.0 apps are secured by bearer authentication. The token is present in the `Authorization` header and is signed with the app's client secret." (A JWT; the HMAC `X-Hub-Signature` scheme is for admin-registered webhooks with a `secret`, not OAuth apps.) | [Webhooks guide — Webhooks authentication for OAuth 2.0 apps](https://developer.atlassian.com/cloud/jira/platform/webhooks/#webhooks-authentication-for-oauth-2-0-apps) |
| `X-Atlassian-Webhook-Identifier` is "unique within a Jira Cloud tenant and is the same across retries". Failed deliveries are retried **up to five times**, 5–15 minutes apart, on **408, 409, 425, 429, 5xx** or a connection failure; retries carry `X-Atlassian-Webhook-Retry`. | [Webhooks guide — Retry policy](https://developer.atlassian.com/cloud/jira/platform/webhooks/) |
| A payload matching our registration carries `matchedWebhookIds`; issue events carry `webhookEvent`, `issue`, and (updates only) `changelog`. | [Webhooks guide](https://developer.atlassian.com/cloud/jira/platform/webhooks/) |
| For non-public OAuth apps, webhooks are delivered only when the app owner is the user who registered them. | [Register dynamic webhooks](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-webhooks/#api-rest-api-3-webhook-post) |
| `cloudId` is the tenant id: Connect's `getTokenResponse(...).tenantId`, or `GET https://api.atlassian.com/oauth/token/accessible-resources`. | [OAuth 2.0 (3LO) apps](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/) |

### How Windkeel uses it

- **Verification** — `Authorization: Bearer <jwt>` must be HS256, signed with
  `WINDKEEL_JIRA_WEBHOOK_SECRET`, compared in constant time, with an unexpired `exp` (60 s leeway), no
  future `iat`, and a lifetime of at most an hour (`exp - iat`, and `exp - now`). Any other `alg`
  (including `none`) is refused. Bad or missing token ⇒ 401 and no row. No secret configured ⇒ 503
  (Jira retries 5xx, so deliveries resume once it is set). **Residual risk:** a captured token
  replays for at most its lifetime (≤ 1 h), and each replay must also carry a new
  `X-Atlassian-Webhook-Identifier` to get past the delivery ledger.
- **Registration filter.** Because labels cannot be filtered at Jira, the webhook is
  `project IN (…)` over the connection's enabled project routes — or, when there is a `default`
  route, over **every project the app can see** (`GET /rest/api/3/project/search`). The label is
  checked on arrival. `fieldIdsFilter: ["labels"]` keeps `jira:issue_updated` to label changes.
  Events: `jira:issue_created`, `jira:issue_updated`. A project created later is picked up by the
  next hourly sweep, which notices the JQL no longer matches and re-registers.
- **Documented limit: 200 projects for a `default` route.** The JQL is chunked at 100 project keys
  per webhook, at most 2 webhooks per connection (Atlassian allows 5 per app per user on a site, and
  a re-registration briefly holds the old set and the new one). Past 200 visible projects the
  first 200 (sorted by key) are watched and `last_error` says how many are not; add `jira_project`
  routes for the rest.
- **When it is (re)registered** — `ensureJiraWebhook` runs after `POST /v1/integrations` for a Jira
  connection, after any route change on one, and in the hourly sweep (`jira-webhook-refresh`, under
  its advisory lock). **One `ensure` per connection at a time**: each takes the connection's
  advisory transaction lock, so an API route change and the sweep never register twice (a second
  caller waits up to 10 s, then gives up without writing and **marks the connection dirty**
  (`jira_webhook_dirty`): the holder re-runs when it finishes, so the change lands in seconds, and a
  mark still standing goes first in the next sweep).
  A changed filter **registers the new webhook first**, records it — moving the stale one to
  `retired_webhook_ids` in the same statement — and only after that commits deletes the stale one.
  A failure part-way leaves a working webhook, never none. If the record does not commit, the new
  webhook is deleted at Jira again; a retired webhook whose delete fails is deleted on a later pass. With no enabled route there is nothing to
  watch, so nothing is registered (and an existing webhook is deleted). The sweep refreshes a
  webhook expiring within 7 days, and re-registers one Jira no longer lists. **Failures never fail
  the request or the sweep**: they are written to `jira_webhook.last_error` and retried on the next
  sweep.
- **Disconnect** — `DELETE /v1/integrations/:id` on a Jira connection deletes its webhooks at Jira
  (best effort, bounded; recorded and retired ids) and its `jira_webhook` row, whatever Jira
  answered. A disconnect that finds the connection busy marks it, and the holder removes on
  finishing; failing that, **the sweep reaps** every `jira_webhook` row of a connection that is no
  longer active (deletes at Jira, then the row) before it ensures the active ones. An orphan would
  hold one of the app's 5 webhooks on that site and could carry an id another tenant's row holds.
  **Residual:** a process that dies between Jira accepting a registration and its record
  committing leaves a webhook no row records (logged with its ids, when a compensating delete also
  fails). Jira's webhook list does not say which URL a webhook points at, so Windkeel cannot tell such
  an orphan from another deployment's under the same Atlassian app, and never deletes one it did
  not record: delete it by id (`DELETE /rest/api/3/webhook` as the app).
- **Everything is bounded** — every Jira request, `accessible-resources` and the Connect token
  fetch get 5 s on a request path (API, acknowledgement comment) and 10 s in the sweep; an API
  request's ensure/remove gets 20 s in all. The sweep handles at most 50 connections per tick
  (reaps included), dirty ones first and then the soonest to expire, and starts none after 120 s;
  the rest are `skipped` and go first next hour. A `default` route's project listing stops paging
  when the budget is spent (that connection fails for this tick rather than register a partial list).
- **Which site an event is from** — `issue.self` of the form `https://api.atlassian.com/ex/jira/{cloudId}/…`
  names it. Otherwise `matchedWebhookIds` is looked up in `jira_webhook.webhook_ids` — **and the
  row's `site_url` must be `issue.self`'s origin.** Jira's webhook ids are per site and small, so they
  collide across tenants, and an orphaned webhook can carry an id another tenant's row holds; a
  match on id alone would route one site's issue into another organization. No site match (or no
  `self`) ⇒ ignored `unknown_tenant`; a row with no recorded site never matches. The site URL is
  recorded before a webhook is registered, so every row with webhook ids has one.
- **Delivery key** — `<site host>/<X-Atlassian-Webhook-Identifier>`, or `<cloudId>/<identifier>` when
  `issue.self` is the `api.atlassian.com` form (the identifier is unique only within a site).
- **Interpretation** — connection by cloud id (`unknown_tenant`); route by project key, else
  `default` (`no_route`; a disabled project route is `route_disabled`, never a fall-through); the
  issue has the route's `trigger_label` (`no_trigger_label`, case-insensitive) and either was just
  created or its `changelog` shows the label added (`label_not_added`). Only issue events are
  handled (`unsupported_event`).
- **The task** — `source_type='jira'`, `source_reference='jira:<cloudId>/<issueId>'` (stable when an
  issue moves project), `source_context={cloudId, issueKey, issueId, siteUrl}`, title
  `<KEY>: <summary>`, description = the ADF description as markdown plus the issue link, risk from a
  `risk:low|medium|high` label, created by the organization's `jira` system actor. **The
  description is bounded**: ADF nested deeper than 50 levels is rendered as that subtree's text,
  flat (no recursion, so a pathological nesting is a normal task, never a 5xx), and the text is cut
  at 20,000 characters with a `[… description truncated by Windkeel]` marker.
- **Re-labelling** mirrors GitHub and Linear through the same code (`src/intake/relabel.ts`
  `retriggerExistingTask`): a run still `CREATED` is re-enqueued; a live run is `already_tasked`; if
  every run is terminal, a fresh run starts on the same task with the issue's current title,
  description, criteria and `source_context`, and the `risk:` label's level (else the task's own).
- **Comments** — after commit the run is enqueued and the issue gets "Windkeel picked this up" with the
  run link (`WINDKEEL_CONSOLE_URL/runs/<id>`), bounded at 5 s; the flow function's notifier comments the
  outcome. Bodies are ADF. The PR link comes from the records (`pullRequestUrl`: the run's
  `pr_number` and the repository's stored `clone_url`), never a hand-built host. A failure reason is
  shown only as a short summary — first line, credentials redacted, links and paths dropped, at most
  160 characters; the full reason stays on the run, behind its link. Each comment carries a marker
  line and is skipped if a recent comment already has it: `windkeel-run <runId> started` for the
  acknowledgement, `windkeel-transition <transitionId>` for an outcome (the committed
  `run_state_transition`, #306) — so a replayed step posts once and a genuine second entry into a
  state (a rework cycle) posts again. A comment that fails is logged (`describeError`) and dropped —
  it never fails the delivery or the run.
- **Notifier registration** — `registerDeploymentNotifiers` (`src/factory/workflow/deployment-notifiers.ts`)
  registers the Jira notifier in the flow function **only when `WINDKEEL_CONNECT_JIRA` is set**; nothing
  in `stage-wiring.ts` imports it.

### Setting it up

1. **Register an Atlassian OAuth 2.0 (3LO) app** at <https://developer.atlassian.com/console/myapps/>.
   Permissions → Jira API: `read:jira-work`, `write:jira-work`, `manage:jira-webhook`, plus
   `offline_access` for refresh tokens. The callback URL is the one the Connect connector gives you.
   Note the client id and **client secret**.
2. **Create a Vercel Connect Custom OAuth connector** for it (authorize
   `https://auth.atlassian.com/authorize?audience=api.atlassian.com`, token
   `https://auth.atlassian.com/oauth/token`, those scopes), link it to the ingress project, and set
   `WINDKEEL_CONNECT_JIRA` to its uid.
3. **Set** `WINDKEEL_JIRA_WEBHOOK_SECRET` (the client secret) and `WINDKEEL_PUBLIC_URL` on the ingress
   project. The flow function needs `WINDKEEL_CONNECT_JIRA` (and `WINDKEEL_CONSOLE_URL` for links) too; in
   today's single-deployment layout that is the same project.
4. **Install** the connector on the Jira site, then connect and route it:

   ```bash
   windkeel integration connect jira <installation-id>
   windkeel integration route add <integration-id> --repo <repository-id>                              # every project
   windkeel integration route add <integration-id> --repo <other-repo-id> --scope jira_project --value ENG
   ```

   Adding the first route registers the webhook. `select * from jira_webhook` shows its ids, JQL,
   expiry and `last_error`.
5. Label an issue `windkeel` (or the route's `triggerLabel`).

**Secret surface.** `WINDKEEL_JIRA_WEBHOOK_SECRET` is a provider secret in ingress's environment. It
grows ADR-0023 §1's secret surface by one optional variable, recorded in ADR-0025's 2026-09-25
amendment (which also amends the Consequence that said this would not happen). It is unavoidable while Jira signs webhooks with the client secret and Connect does not forward Jira
events: whoever verifies them needs the secret. It is optional, read per request, never logged or
echoed, and it cannot mint tokens on its own (that needs a user's refresh token, which Connect holds).

## Linear (M8-7)

A Linear issue carrying its route's trigger label (default `windkeel`) becomes a task, the same way
the GitHub `windkeel` label does. The issue gets an "Windkeel started · <run link>" comment, and later
the outcome: the draft pull request, the failure reason, or a request to approve generated
acceptance criteria.

**Connector and trigger.** One Vercel Connect Linear connector (`WINDKEEL_CONNECT_LINEAR`), installed
per Linear workspace and connected to an organization as above. Its Connect trigger forwards
Linear's `Issue` webhooks to **`POST /api/intake/linear`**. Connect checks Linear's signature and
adds a Vercel OIDC bearer, which is what we verify (`verifyConnectForward`); we do not hold
Linear's signing secret. A `webhookTimestamp` more than 5 minutes from now either way is `401`
(replay guard). The delivery key is the `Linear-Delivery` header, else
`{webhookId}:{data.id}:{webhookTimestamp}`.

**What starts a task.** An `Issue` event whose `action` is `create` with the trigger label, or
`update` whose `updatedFrom.labelIds` shows the label was just added — any label carrying the
trigger name whose id is new counts (a team label and a workspace label may share a name). The
label is matched by **name** from `data.labels`; a payload carrying only `labelIds` cannot be
matched without an API call and is ignored as `labels_unavailable` (a known gap until M8-0, #292,
confirms which shape Connect forwards). **The route is resolved before the label is checked**,
because the trigger label belongs to the route: which label counts depends on which team's route
the issue falls under. The workspace is resolved
from `organizationId`; the route is the `linear_team` route for the issue's team (by id, or by team
key), else the connection's `default`. The task is `source_type = 'linear'`, reference
`linear:{organizationId}:{issueId}`, created by the organization's `linear` system actor; risk
comes from a `risk:low|medium|high` label (`low` when absent on a new task); `source_context` holds `{organizationId, issueId,
identifier, url, teamId}` — routing only, never a token.

Everything else is recorded in `intake_delivery` as ignored, with its reason:

| Reason | Means |
| --- | --- |
| `unknown_tenant` | No active connection for this Linear workspace. |
| `not_an_issue` | A `Comment`, `Project`, … event. |
| `removed` | The issue was deleted. |
| `no_route` / `route_disabled` | Nowhere to send it, or its team route is switched off (it does not fall through to the default). |
| `label_absent` | The issue does not carry the route's trigger label. |
| `labels_unavailable` | The payload has `labelIds` but no `labels`, so the trigger label's name cannot be checked. |
| `unsupported_action` / `malformed_issue` | An action other than create/update/remove, or an issue without an id. |
| `label_not_newly_added` | An update that did not add the label (an edit to an already-labelled issue). |
| `already_tasked` | The label was re-added while the issue's run is still live. |

**Re-labelling mirrors GitHub, through the same code** (ADR-0009 §3,
`src/intake/relabel.ts` `retriggerExistingTask`, which the GitHub label uses too): a run still at
`CREATED` is re-enqueued (the heal for a failed enqueue); a live run is `already_tasked`; if every
run is terminal, a fresh run starts on the same task with the issue's current title, description,
criteria and `source_context`, the source's rails, and the `risk:` label's level — or, with no
`risk:` label, the task's existing risk.

**A failed enqueue is healed by the sweep, not the retry.** Linear retries a failed delivery at
1 min / 1 h / 6 h; the later retries fall outside the 5-minute replay window and are refused. The
stranded-run sweep (docs/sweeps.md) starts any run still `CREATED` with no binding ten minutes
after creation. The replay window stays strict.

**Outbound.** `src/integrations/linear.ts` — `fetch` to `https://api.linear.app/graphql`
(`commentCreate`), token from `withProviderToken`, no SDK. Every comment carries a deterministic
client-chosen id — the start comment from its run, an outcome comment from the committed
transition it reports (`RunOutcome.transitionId`) — so a retried workflow step or a re-run
after-commit is refused by Linear as a duplicate instead of posting twice.

**Duplicate detection is unverified.** Linear does not document how it refuses a `commentCreate`
whose id already exists. We treat exactly one shape as "already posted": a single GraphQL error
with `extensions.code = "INVALID_INPUT"` and a message beginning `Entity already exists`
(`isDuplicateError`). Anything else is a failure, logged — never read as posted. M8-0 (#292)
captures the real response; correct `isDuplicateError` then.

**The start comment is bounded.** It is posted after commit but before we answer Connect, so the
Connect token fetch and the Linear request together get 5 s (`LINEAR_START_COMMENT_TIMEOUT_MS`);
on timeout it is logged and the delivery answers normally.

The outcome notifier (`registerLinearNotifier`) is registered by `registerDeploymentNotifiers`
(`src/factory/workflow/deployment-notifiers.ts`) from the flow function's `buildAndPublish` —
where `advanceRun` runs — **only when `WINDKEEL_CONNECT_LINEAR` is set**. The pull-request link comes
from the records (the run's `pr_number`, the repository's stored `clone_url`), never a hand-built
host. A failed comment is logged (error name, codes — never Linear's message text or the body) and
never fails the delivery or the run. The run link uses `WINDKEEL_CONSOLE_URL` when set (optional, read
per request).

## Sentry

A Sentry **alert** becomes a task through the same pipeline and the same loop as every other
source — run → independent verification → draft PR — and the Sentry issue hears back with the
verdict. Nothing here creates, marks or describes a PR as ready, and nothing resolves the Sentry
issue: merging is a human's call.

### What Sentry documents (checked 2026-10-21)

docs.sentry.io was not reachable from the build environment; this was checked through search
results quoting the [Integration Platform webhooks](https://docs.sentry.io/organization/integrations/integration-platform/webhooks/)
page, and **must be re-checked against the live docs before going live**:

| Fact | Source |
| --- | --- |
| Webhooks carry `Content-Type`, `Request-ID`, `Sentry-Hook-Resource`, `Sentry-Hook-Timestamp` and `Sentry-Hook-Signature`. | Integration Platform → Webhooks |
| `Sentry-Hook-Resource` is one of `installation`, `event_alert`, `metric_alert`, `issue`, `error`, `comment`, `seer` (newer docs add `preprod_artifact`). | Same |
| `Sentry-Hook-Signature` is the hex HMAC-SHA256 under the integration's **client secret**. Sentry's example hashes the JSON-serialised body; we hash the **raw bytes received**, which is what Sentry signed. | Same |
| An issue alert rule's webhook arrives as `event_alert` with `action: "triggered"`, `data.event` and `data.triggered_rule` (the rule's name); a metric alert as `metric_alert` with `action` `critical` / `warning` / `resolved`. Every body carries `installation.uuid`. | Same (alert-rule and metric-alert payload pages) |
| `Sentry-Hook-Timestamp` is read as Unix seconds (a millisecond value is accepted too). Not confirmed in the docs reached. | — |

### How Windkeel uses it

| Step | Detail |
| --- | --- |
| Verify | `verifySentrySignature`: constant-time `verifyHmacSha256` over the raw body, then the timestamp within 5 minutes either way (`withinTolerance`). Secret unset ⇒ `503 integration_misconfigured`; a bad, missing or non-hex signature or a stale/missing timestamp ⇒ `401`. Nothing is parsed or written before this. Sentry signs the body only, so the timestamp (and `Request-ID`) are unauthenticated: the window stops stale redeliveries, while a deliberate replay of a captured body is bounded by one task per Sentry issue (`duplicate`). |
| Delivery key | `<installation uuid>/<Request-ID>`; without a `Request-ID`, `<uuid>/sha256:<hash of resource + body>`. A redelivery is `duplicate`. |
| Acted on | `event_alert` (`triggered`) and `metric_alert` with `action: critical`. Everything else is ignored `sentry_resource_not_acted_on:<resource>` (`…:metric_alert.resolved`, `…:issue`, `…:installation`, …). |
| Tenant | `installation.uuid` = `integration_connection.external_tenant_id` (`provider='sentry'`); the org slug is `external_tenant_name`. Unknown or disconnected ⇒ `connection_not_found`. |
| Route | `sentry_project` route for the project slug (from the event's API `url`, or the metric alert rule's first project), else `default` (`no_route`, `route_disabled`). |
| Trigger | **The alert rule's name, not a label**: the route's `trigger_label` (default `windkeel`) must equal the rule name or appear in it as a whole word, case-insensitively (`windkeel: checkout errors`); `*` matches every rule. Else `no_trigger_match`. |
| Act | Grant re-checked (`repository_not_granted`); a Sentry issue that already has a task ⇒ `duplicate` (one task per issue: `source_reference = sentry:<uuid>/<issue id>`, the 0023 unique index); then the **rate cap** — at most **20 new tasks per connection per hour** (`SENTRY_TASKS_PER_CONNECTION_PER_HOUR`), counted over this connection's `intake_delivery` rows under an advisory lock in the same transaction — else `rate_limited`. Then the task, as the organization's `sentry` system actor, risk `medium`. |
| Task | Title `Fix Sentry issue <shortId>: <title>` (≤ 300). Description: culprit, error type/value, the newest in-app stack frames (`file:line in function`), environment, release, first seen and event count when present, and the Sentry issue URL (≤ 64 KiB). `source_context = {installationUuid, orgSlug, projectSlug, issueId, shortId, issueUrl}`. A metric alert's subject is the alert (`sentry:<uuid>/metric_alert/<id>`, `issueId: null`: nothing to comment on). |
| Untrusted text | Anyone who can make the application throw chooses the error message. Every payload string is flattened to one line, bounded, and placed on a line beginning `> ` under a note that it is quoted, untrusted data — so no line of it can become a heading, a checklist item or an **acceptance criterion**. A Sentry task therefore has no explicit criteria and takes the generate-then-approve route (ADR-0012): **a human approves its criteria** before anything is provisioned. Payload text never reaches a log, a reason, a shell or a prompt template. |

| Reason | Means |
| --- | --- |
| `sentry_resource_not_acted_on:<resource>` | Not an issue alert firing or a metric alert going critical. |
| `connection_not_found` | No active connection for that Sentry installation. |
| `no_alert_subject` | An alert without an issue id (or metric alert id). |
| `no_route` / `route_disabled` | Nowhere to send it, or its project route is off. |
| `no_trigger_match` | The alert rule is not named for the route's trigger. |
| `repository_not_granted` | The route's repository is no longer granted. |
| `duplicate` | That Sentry issue already has a task (a re-firing alert). |
| `rate_limited` | This connection already created 20 tasks in the last hour. |

### Post-back, and where its token comes from

The notifier (`registerSentryNotifier`, flow function, **only when `WINDKEEL_CONNECT_SENTRY` is set**)
comments on the issue with `POST https://sentry.io/api/0/issues/{issueId}/comments/` on `started`,
`progress` (once per run), `WAITING_FOR_APPROVAL`, `WAITING_FOR_HUMAN` (verdict + draft PR) and
terminal states — see [Status updates](#status-updates-the-verifiers-verdict). Each post is claimed
first in `source_context.notified` (`started:<runId>`, `verifying:<runId>`, else the transition id),
so a replayed step posts nothing; 429/5xx are retried twice (0.5 s, 2 s; a `Retry-After` up to 4 s is
honoured) and then the claim is released for a replay; a 401/4xx or an abort mid-request keeps it (a
duplicate is worse than a gap). Failures are logged with `describeError` and never reach the run.

**Token path (the spike, 2026-10-21).** Vercel Connect has no Sentry connector, and a Custom OAuth
connector cannot hold a Sentry *integration* credential: Sentry's installation tokens come from a
non-standard, installation-scoped exchange (`POST /api/0/sentry-app-installations/{uuid}/authorizations/`
with the client secret) and expire after hours, which a generic OAuth connector does not perform.
So, per the maintainer's decision, **the token is stored sealed** — ADR-0034, a Sentry-only
exception to ADR-0025 §1. An administrator passes it when connecting; ingress seals it with
`WINDKEEL_SECRET_PUBLIC_KEY` (and cannot open it); only the flow function's notifier opens it, with
`WINDKEEL_SECRET_PRIVATE_KEY`, inside one call. The sealed value is bound to
`sentry_credential:<organization>:<connection>`, so a copy onto another connection does not open.
Today that token is an **internal integration's** token (it does not expire); a public
integration's refreshing token is not handled yet.

### Setting it up

1. In Sentry, create an integration (internal is simplest) with **webhooks** on and the
   **Alert Rule Action** enabled, permission *Issue & Event: Read & Write* (comments need write).
   Webhook URL: `{WINDKEEL_PUBLIC_URL}/api/intake/sentry`. Note its **client secret** and its
   **token**, and the installation's uuid (the `installation` webhook, or the integration's page).
2. Set `WINDKEEL_SENTRY_CLIENT_SECRET` on the ingress, and `WINDKEEL_CONNECT_SENTRY=sealed` plus the
   `WINDKEEL_SECRET_*` key pair (public half on ingress, private half on the flow function).
3. Connect: `POST /v1/integrations {"provider": "sentry", "externalTenantId": "<installation uuid>",
   "orgSlug": "<org slug>", "token": "<integration token>"}` — the answer carries the token's last
   four characters, never the token. Without `token`, alerts still become tasks and nothing is
   posted back. (The console's connect form takes the uuid as the installation id; the token is
   API-only for now.)
4. Route: `POST /v1/integrations/{id}/routes {"scopeKind": "sentry_project", "scopeValue":
   "<project slug>", "repositoryId": "…"}`.
5. In Sentry, create an alert rule **named** with the trigger word (`windkeel: checkout errors`) whose
   action sends to the integration.

## Slack intake

A slash command or an @mention in a **mapped channel** starts a task; the thread gets the run link
and, later, the outcome (#298). An ignored mention gets an ephemeral explanation (#312). Code: `src/intake/slack.ts` (source + notifier),
`src/integrations/slack.ts` (`SlackClient`: Web API over plain `fetch`, no Slack SDK).

### Setup

1. **Connector.** Create the Slack connector in Vercel Connect with the bot scopes
   `commands`, `chat:write`, `app_mentions:read`, `channels:join`, and set `WINDKEEL_CONNECT_SLACK`
   to its uid. `WINDKEEL_CONNECT_SLACK` is also what makes the flow function register the Slack
   notifier (`registerDeploymentNotifiers`); without it nothing is ever posted.
2. **Triggers.** Point the connector's slash command (`/windkeel`) and its Events API subscription
   (`app_mention`) at `https://<ingress>/api/intake/slack`. Connect verifies Slack's signature and
   forwards the request with a Vercel OIDC bearer; we verify that bearer (`verifyConnectForward`)
   and hold no Slack signing secret.
3. **Connect the workspace:** `windkeel integration connect slack <installation-id>`.
4. **Map each channel** that may start work:

   ```bash
   windkeel integration route add <integration-id> --repo <repository-id> --scope slack_channel --value C0123ABCD
   ```

   Public channels need nothing more: the first post that meets `not_in_channel` joins the channel
   (`conversations.join`, scope `channels:join`) and retries once. **Private channels must invite
   @Windkeel** — Slack refuses the join; the notifier logs `slack channel join failed: if the channel
   is private, invite @Windkeel to it` and posts nothing.
5. Optional: `WINDKEEL_CONSOLE_URL` makes the run link a console link (otherwise the run id is shown).

**There is no workspace-wide default for Slack.** A `default` route on a Slack connection is
ignored by the intake; only a `slack_channel` route naming the channel counts. This is a security
choice: **anyone who can post in a mapped channel can start work in its repository — and, by
naming it (`/windkeel owner/repo …`), in any repository granted to the organization** — so map only
channels whose members you would give that power. A disabled channel route is ignored
(`route_disabled`).

### Grammar

```
/windkeel help
/windkeel [owner/repo] <title>[ -- <description> | <newline><description>] [risk:medium|risk:high]
@Windkeel <same as above>
```

`help` answers the usage even from a workspace that is not connected yet. A first word shaped like
`owner/repo` selects that repository **only when it is one granted to the organization**, and only
in a mapped channel (an unmapped channel is `no_route` either way); otherwise the word stays in
the title, so `/windkeel and/or fix login` is a task titled "and/or fix login" in the channel's
repository. Risk defaults to `low`. Acceptance criteria are extracted from the description
(ADR-0012); none ⇒ generated and held for approval.

### What happens

| Step | Detail |
| --- | --- |
| Delivery key | `trigger_id` (slash command) / `event_id` (event). Slack retries (`X-Slack-Retry-Num`) are duplicates. |
| Task | `source_type='slack'`, `source_reference='slack:{team_id}:{key}'`, `source_context={teamId, channelId, threadTs, requestedBySlackUser}`, created by the organization's `slack` system actor. |
| Ignored mention | `help` / `no_route` / `route_disabled` ⇒ one ephemeral to the mentioning user, posted by the flow function after the ingress has answered — see [Ignored mentions](#ignored-mentions-ephemeral-feedback). |
| Response | A slash command is answered `{"response_type":"ephemeral","text":"Starting…"}` (or the reason it was ignored, e.g. `no_route`, `unknown_tenant`, `help`; `Already on it.` for a duplicate) once the transaction commits and the run is enqueued. The body goes through the pipeline's one reply channel (`IntakeSource.respond` → `IntakeResponse.reply`, docs/webhook-ingress.md "The response seam"). **The intake makes no Slack or Connect call**, so Slack's 3-second rule holds by construction. |
| Thread root | Created by the **notifier**, in the flow function, never by the ingress. `ensureThread(task)` atomically claims `source_context.announce`, posts "Task *title* started · run link" (a channel root for a slash command — its `ts` becomes `threadTs` — or into the mention's thread), and stores the `ts`. The seam's `started` outcome (the run's first move out of `CREATED`, src/intake/notifiers.ts) triggers it; every other outcome calls it first, so the root always precedes the outcome and there is only ever one. A call that finds the claim in flight waits for it (≤ 5 s, and never past its abort signal). A claim with no `ts`, not marked `failed`, and older than 30 s is abandoned (its holder died between claim and post) and is reclaimed atomically by the next call. **Once Slack has accepted the start message its claim is never released**: a failed `ts` write is retried twice, then the claim is marked `announce.failed` (`ts_not_stored`) and logged. |
| Progress | Once per run, when it first enters `VERIFYING`: "*title*: Verifying in an independent sandbox… · run link" (#389). Claimed as `verifying:<runId>` in `source_context.notified`, so a repair loop's later entries post nothing. |
| Outcome | Posted into the thread on `WAITING_FOR_APPROVAL` (how to approve: `windkeel approve <run-id>` / console), `WAITING_FOR_HUMAN` (the verifier's verdict — "Verified ✓ N/N criteria · draft PR #n" only when it passed, else "needs a human — Not verified: k of N criteria failed" — PR link from the run's `pr_number` and the repository's `clone_url`), and every terminal state (the verdict on a failure, and the relayed reason). See [Status updates](#status-updates-the-verifiers-verdict). Each outcome is claimed on its committed transition (`outcome.transitionId`) in `source_context.notified` before posting: a retried workflow step posts nothing twice, and a genuine second entry into a state (a rework cycle) posts again. |
| Retries | A transient failure (HTTP 429/5xx, `ratelimited`, a connection never made — DNS failure, connection refused, connect timeout: `connect_error`) is retried in-process: 2 retries, backoff 0.5 s then 2 s (a longer `Retry-After` is honoured), never waiting past 8 s from the start of the notification. Still failing ⇒ the claim is **released** and the failure logged, so a replayed step can try again. If the start message is what failed, the outcome is not posted either (its claim is never taken), so a replay posts both, in order. **Nothing guarantees that replay:** a terminal outcome (the last notification a run makes) whose start message failed transiently waits for a replayed workflow step that may never come, and is then lost — logged, never posted. |
| Kept claims | A post Slack may have accepted — our deadline hit mid-request (`timeout`), a connection lost after it was made (`network_error`: `fetch` cannot say whether Slack had already read the body, so it counts as delivered), or `ok:true` without a `ts` (`missing_ts`; an empty `ts` is never stored) — **keeps** its claim: a duplicate is worse than a gap. So do permanent refusals (`channel_not_found`, `is_archived`, a private channel's `not_in_channel`). A kept start-message claim is marked `announce.failed`, and later outcomes go to the channel (or the mention's thread). |
| Errors | `invalid_auth`/`token_expired` ⇒ one token refresh and one retry. Every failure — a refusal, a failed claim release (`slack claim release failed`), a database read — is logged with `describeError` (never a token) and never fails the run. |
| `url_verification` | Answered `{challenge}`; nothing is written. |

### Ignored mentions: ephemeral feedback

An event has no reply channel, so an `app_mention` the intake ignores for **`help`, `no_route` or
`route_disabled`** is answered with one `chat.postEphemeral` (scope `chat:write`) that only the
mentioning user sees — the same text a slash command gets for that reason (`SLACK_IGNORE_TEXT`),
in the mention's thread when it was in one, else in the channel (#312). **The ingress still makes
no Slack call:**

1. **Ingress, in the delivery's transaction:** the ledger row is recorded `intent='ignore'` with
   its reason as always, and its `response` column gets the feedback need —
   `{"slackFeedback": {"state": "pending", reason, teamId, channelId, user, threadTs}}` (routing
   only: no token, no message text). No migration: `intake_delivery.response` (0027) is reused.
2. **Ingress, after commit:** the delivery key — and nothing else — is enqueued to the flow
   function (`startSlackMentionFeedback` → the one-step `orqonSlackMentionFeedbackFlow`,
   `src/factory/workflow/slack-feedback-flow.ts`). That is a Workflow queue write, like the run
   enqueue, never Slack HTTP; the response is sent after it. A failed enqueue is logged
   (`slack mention feedback not started`) and the mention still answers `200 ignore` — the
   delivery was handled, and a 500 would only make Slack redeliver it.
3. **Flow function:** `postIgnoredMentionFeedback` claims the row (`pending → posting`, one
   atomic update) **before** posting, so a second start or a replayed step posts nothing, then
   posts and marks it `posted`.

| Case | What happens |
| --- | --- |
| Duplicate delivery (Slack retry) | The ledger's claim answers `duplicate` before `act`: no second record, no second enqueue, no second post. |
| `unknown_tenant` | **Never answered** — we hold no token for that workspace. A `help` mention from an unconnected workspace is not answered either. |
| Other reasons (`empty_title`, `repository_not_granted`, `bot_message`, …), a mention with no `user`, a slash command | No feedback recorded (slash commands already get their ephemeral reply). |
| `WINDKEEL_CONNECT_SLACK` unset | Read per request by the ingress: no feedback is recorded or enqueued. The flow-function step also skips without it. |
| Transient failure | Retried in-process exactly as the notifier does (2 retries, ≤ 8 s); still failing ⇒ released to `pending` and the step throws, so the Workflow's step retry tries again. |
| Refusal, or a post Slack may have accepted (`channel_not_found`, `not_in_channel`, `timeout`, `network_error`) | Marked `failed` with Slack's code and kept: a duplicate is worse than a gap. |
| Workspace disconnected before the step runs | Marked `skipped` (`not_connected`); no Slack call. |
| Step dies between claim and post | The row stays `posting`; nothing reclaims it, so that mention gets no feedback (a gap, never a duplicate). |

The rows are ignored rows, so the ledger's 30-day retention prunes them with their feedback state.

## Signed webhooks, the API and schedules

These three need no provider and no Connect connector; they are Windkeel's own front doors.

**Signed webhooks** (M8-5, [webhook-intake.md](webhook-intake.md)). Set `WINDKEEL_WEBHOOK_SIGNING_KEY`,
then an admin makes an endpoint — `windkeel webhook create --name pagerduty --repo <repository-id>`,
`POST /v1/webhook-endpoints`, or the console's **Settings → Webhook endpoints**. The answer carries
the endpoint's `whsec_…` secret **once**; hand it to the sending system. It signs
`{timestamp}.{body}` with HMAC-SHA256 and sends `X-Windkeel-Timestamp`, `X-Windkeel-Signature` and
`X-Windkeel-Delivery` to `POST /api/intake/webhook/{endpointId}`. A repeated `X-Windkeel-Delivery` is a
duplicate — one task, however often the sender retries. `windkeel webhook send` does the signing for a
test. Rotating the endpoint revokes every earlier secret at once.

**PagerDuty, Datadog, Opsgenie** are not first-class sources; they reach the factory through a
signed webhook endpoint. Point the tool's outgoing webhook (or a small relay — PagerDuty's v3
webhooks, Datadog's webhook integration, Opsgenie's outgoing webhook) at the endpoint URL, sign
`{timestamp}.{body}` with the `whsec_` secret as [webhook-intake.md](webhook-intake.md) describes,
and send `{"title": …, "description": …}`. Everything that applies to Sentry's payload text applies
there: it is untrusted input.

**The API** (M7, with M8-5's `Idempotency-Key`). An automation should call as a **service
principal** (`windkeel service-principal create --name ci`, then `windkeel service-principal token create <id>`;
console **Settings → Service principals**), never with a person's token: the service principal outlives whoever set it up, and
its token is revoked without touching anyone's login. Send `Idempotency-Key` on `POST /v1/tasks` and
a retried request answers the original `202` (with `Idempotent-Replayed: true`) instead of creating
a second task. The key is per principal.

**Schedules** (M8-4, [schedules.md](schedules.md)). `CRON_SECRET` must be set (Vercel sets it for
cron invocations once the project has one). An admin creates a schedule — `windkeel schedule create`,
`POST /v1/schedules`, or **Settings → Schedules** — and the five-minute tick fires each slot as one
task. Missed slots after downtime coalesce into one; a schedule pauses while the PR its last run
opened is unmerged.

## Going live

The automated proof is `test/e2e-m8-intakes.test.js` (fakes for every provider). The live proof is
the checklist on [#302](https://github.com/jyothepro/orqon/issues/302): one run of each source
against the preview deployment of `m8-automations-integrations`, after the M8-0 spike (#292), with
the observable result each step should produce.

**Sentry (#389), once a Sentry org exists:** create the integration and set
`WINDKEEL_SENTRY_CLIENT_SECRET`, `WINDKEEL_CONNECT_SENTRY` and the `WINDKEEL_SECRET_*` pair; connect with
`POST /v1/integrations` (uuid, slug, token) and add a `sentry_project` route; fire a test alert
from a rule named `windkeel …`. Expect: an `intake_delivery` row `create_task`, a task in the console
held for criteria approval, comments on the Sentry issue — started, the approval request, then
after approval "Verifying…" and "Verified ✓ N/N criteria · draft PR … · run …". Re-check the
webhook headers and the `Sentry-Hook-Timestamp` unit against the live docs (above) first.
