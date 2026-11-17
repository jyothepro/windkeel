# The control plane API

Every endpoint, what it answers, and how a client follows a run. The decisions behind the shape
are [ADR-0023](adr/0023-control-plane-api-reads-direct-writes-intents-updates-resume-from-a-cursor.md);
this is the operator's page.

Base path `/v1`, served by `apps/ingress` — the same deployment as the GitHub webhook
([ADR-0002](adr/archive/0002-control-plane-is-hybrid-vercel-ingress-plus-worker-container.md) §1).

## Authentication

Three kinds of bearer, told apart by shape ([ADR-0024](adr/0024-tenancy-is-account-organization-principal-and-supabase-auth-only-signs-people-in.md)):

| Bearer | Who it is | How you get one |
| --- | --- | --- |
| `orq_…` | A personal token. It acts as its owner, narrowed to the scope chosen when it was made | `windkeel login`, `windkeel token create`, or the console |
| A Supabase access token | A signed-in person | The console's GitHub sign-in (`SUPABASE_URL` set, and `migrations/supabase/github_identity_of.sql` applied) |
| `WINDKEEL_API_TOKEN` | The seeded `operator`, an account admin. Break-glass | The deployment's configuration |

```bash
curl -s -H "Authorization: Bearer $WINDKEEL_API_TOKEN" https://$HOST/v1/runs | jq
```

**Scopes.** A token's power is its owner's role in the organization, intersected with the token's
permissions. Presets:

| Preset | Permissions | For |
| --- | --- | --- |
| `read` | `runs.read` | An agent that only watches |
| `execute` (default) | `runs.read`, `runs.write` | Submit, cancel, guide |
| `approve` | `+ runs.approve` | Sign off generated criteria |
| `admin` | `+ secrets.manage`, `repositories.manage`, `members.manage`, `tokens.manage`, `integrations.manage`, `schedules.manage`, `models.read`, `models.manage`, `runs.takeover`, `runs.merge`, `audit.read`, `roles.manage`, `account.manage`, `batches.manage` | People, grants, tokens, integrations, schedules, batches, model credentials, and the account's audit log, roles and policy (`runs.merge` is held, but the merge route refuses every token) |

A request beyond its scope is `403` with `code: "forbidden"` and `missing: "<permission>"`. A token
can only make tokens if it holds `tokens.manage`, and never one wider than itself.

**Organizations.** Every organization route also answers under `/v1/orgs/{orgId}/…`. The
unprefixed form works for a caller in exactly one organization. A caller in several gets `400
organization_required`, listing them. Another organization's run, task or repository is `404`, not
`403`.

**If neither `WINDKEEL_API_TOKEN` nor sign-in is configured, the API answers `503`, not `200`.** A
control plane that fell open because a variable was missing is not a failure mode worth having.
`GET /v1/health` and the two halves of the CLI's device login are the only routes that need no
credential.

| Route | Needs |
| --- | --- |
| `GET /v1/self` | Any credential. Returns the principal, account, organizations with effective permissions, token, and `via` |
| `GET` / `POST /v1/tokens`, `POST /v1/tokens/{id}/revoke` | Your own tokens. Creating one with a token needs `tokens.manage` |
| `POST /v1/auth/device`, `POST /v1/auth/device/token` | Nothing: the CLI's device login ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)). Needs `WINDKEEL_CONSOLE_URL` |
| `GET /v1/auth/device/{code}`, `POST …/approve`, `POST …/deny` | A signed-in session. A token is refused with `session_required` |
| `GET /v1/members`, `POST /v1/members/{id}/role`, `POST /v1/members/{id}/delete` | `runs.read` to list, `members.manage` to change |
| `GET` / `POST /v1/invitations`, `POST /v1/invitations/{id}/delete` | `members.manage`. Invites a GitHub login, matched on its numeric id |
| `GET` / `POST /v1/repositories/grants`, `POST /v1/repositories/grants/{id}/delete` | `runs.read` to list, `repositories.manage` to change |
| `GET` / `POST /v1/service-principals`, `DELETE /v1/service-principals/{id}` (or `POST …/{id}/delete`) | `tokens.manage`. See [service principals](#service-principals) |
| `GET` / `POST /v1/service-principals/{id}/tokens`, `DELETE …/tokens/{tokenId}` (or `POST …/tokens/{tokenId}/revoke`) | `tokens.manage` |
| `GET` / `POST /v1/integrations`, `DELETE /v1/integrations/{id}`, `POST /v1/integrations/{id}/routes`, `PATCH` / `DELETE /v1/integrations/{id}/routes/{routeId}` | `runs.read` to list, `integrations.manage` to change. Slack, Linear and Jira workspaces and where their work goes — see [integrations.md](integrations.md) |
| `GET` / `POST /v1/schedules`, `GET` / `PATCH` / `DELETE /v1/schedules/{id}`, `POST /v1/schedules/{id}/fire`, `GET /v1/schedules/preview` | `runs.read` to read, `schedules.manage` to change or fire. Cron-triggered tasks — see [schedules.md](schedules.md) |
| `GET` / `POST /v1/batches`, `GET /v1/batches/{id}`, `POST /v1/batches/{id}/pause` / `resume` / `cancel` | `runs.read` to read, `batches.manage` to create or change. One change fanned out into many independently verified runs — see [batches](#batches) and [batches.md](batches.md) |
| `GET` / `POST /v1/model-credentials`, `PUT` / `DELETE /v1/model-credentials/{id}`, `POST …/{id}/validate` | `models.read` to list, `models.manage` to change. See [model credentials](#model-credentials) |
| `GET` / `PUT` / `DELETE /v1/model-policy` | `models.read` to read, `models.manage` to change. See [model policy](#model-policy) |
| `GET` / `POST /v1/model-policy/presets`, `PUT` / `DELETE /v1/model-policy/presets/{id}` | `models.read` to list, `models.manage` to change. See [presets](#presets) |
| `GET` / `POST /v1/playbooks`, `GET` / `PATCH` / `DELETE /v1/playbooks/{id-or-slug}` | `playbooks.read` to read, `playbooks.manage` to change. Built-ins are read-only (`409 builtin_readonly`); `POST { from }` copies one; `DELETE` archives. See [playbooks.md](playbooks.md) |
| `GET /v1/runs/{id}/merge-eligibility`, `GET` / `PUT /v1/merging` | `runs.read` to read, `members.manage` to change the organization's setting. `404 merging_disabled` unless `WINDKEEL_MERGE=1`. See [merging as the person](#merging-as-the-person) |
| `POST /v1/runs/{id}/merge` | `runs.merge` **and a signed-in session**; a token is refused with `session_required` |
| `GET` / `POST` / `DELETE /v1/github-authorization` | Your own. Connecting and disconnecting need a signed-in session |
| `GET /v1/audit-events`, `GET /v1/audit-events/export` | `audit.read` in the organization. That organization's audit events. See [the audit log](#the-audit-log) |
| `GET /v1/roles` | `members.manage`. The roles a member can be given: built-ins, then the account's own |
| `GET /v1/account/…` | An **account role**, holding the route's permission; a pinned token is refused. See [account routes](#account-routes) |

`WINDKEEL_API_SUBJECT` names the bootstrap token's holder in the audit trail of anything it commands.

### Service principals

An automation — a schedule, a CI job, a Slack or Linear intake — should not act as a person: a
personal token stops working when its owner leaves. A **service principal** is a non-human identity
in one organization, with one role there (`admin`, `member` or `viewer`), and its tokens keep working
when the person who made them is removed. Every route is organization-scoped and needs `tokens.manage`.

| Route | Body | Answer |
| --- | --- | --- |
| `POST /v1/service-principals` | `{ name, role? }` (role defaults to `member`) | `201 { servicePrincipal }` |
| `GET /v1/service-principals` | | `{ items }`, including the organization's built-in system actors (`system: true`) |
| `DELETE /v1/service-principals/{id}` | | `200`. Revokes every token it holds; it stops appearing in the list. System actors are refused (`400`) |
| `POST /v1/service-principals/{id}/tokens` | `{ name, expiresAt?, preset? \| permissions? }` | `201 { token, secret }`. `secret` is the value, shown **once** |
| `GET /v1/service-principals/{id}/tokens` | | `{ items }`: names, prefixes, states. Never a value |
| `DELETE /v1/service-principals/{id}/tokens/{tokenId}` | | `200 { token }`, revoked |

- A service token is an ordinary `orq_` token, owned by the service principal and always pinned to
  its organization. `GET /v1/self` with it reports the service principal (`principal.kind: "token"`).
- Its power is the service principal's role intersected with the token's permissions. With no scope
  given, the token gets the role less the admin permissions; it can never exceed the role or what
  the creator holds. Nobody can make a service principal whose role holds more than they do.
- A service principal cannot mint tokens for itself, and it is not listed or managed as a member.
- A rejected, revoked or expired token is `403 forbidden`, indistinguishable from an unknown one.

## The audit log

Every administrative act and every run milestone an auditor joins on is one row of `audit_event`
(`migrations/0039_audit_event.sql`, [ADR-0030](adr/0030-the-audit-log-is-a-per-account-hash-chain-roles-and-policy-are-the-accounts.md)),
written in the same transaction as the change. A row names the actor (`actorKind`: `user`, `token`
— the bootstrap token included — `github`, `system`), the action, the target, the client address,
user agent and request id, and a `detail` that never carries a token, secret or key value.

Actions: `session.signed_in` / `session.refused` / `request.ip_denied`; `token.created` / `revoked`;
`service_principal.created` / `deleted`; `member.role_changed` / `removed`; `invitation.created` /
`deleted` / `accepted`; `grant.created` / `deleted`; `secret.set` / `deleted`; `model_credential.*`,
`model_policy.*`, `model_preset.*`; `integration.*`, `integration_route.*`, `schedule.*`,
`webhook_endpoint.*`, `merging.changed`; `run.approved`, `run.cancelled`, `run.takeover_requested`,
`run.submitted`, `run.handed_back`, `run.merge_requested`, `run.verified`, `run.verification_failed`,
`run.merged`, `run.merge_failed`, `run.pr_closed`; `role.*`; `policy.updated`,
`access_review.exported`, `audit.exported`, `audit.deleted`, `audit.retention_swept`. The list is
`AUDIT_ACTIONS` in `src/factory/audit-log.ts`.

**Proving a merge was verified.** `run.verified` carries `verificationRunId` and `candidateSha`;
`run.merged` from Windkeel carries the same `verificationRunId` and `verifiedSha`. A merge done on
GitHub is `run.merged` with `actorKind: "github"` and `detail.via: "github"`.

| Route | Query | Answer |
| --- | --- | --- |
| `GET /v1/account/audit-events` (or `/v1/orgs/{id}/audit-events`) | `after`, `before` (ISO 8601; `after` inclusive), `action` (exact, or a prefix ending `*`: `token.*`), `actor` (principal id), `org` (account route only), `cursor`, `limit` (≤ 500) | `{ items, endCursor, hasNextPage }`, newest first |
| `GET /v1/account/audit-events/export` (or the organization's) | the same filters, `format=jsonl\|csv`, `cursor` | The file itself, oldest first. At most ~4 MB a response; `x-windkeel-next-cursor` names the next part. Each part is audited |
| `GET /v1/account/audit-events/verify` | | `{ ok, checked, brokenAt? }`: `brokenAt` names the `seq` and `hash_mismatch`, `chain_broken`, `sequence_gap` or `unanchored_start` |
| `DELETE /v1/account/audit-events` | `before` (required) | `account.manage`. Deletes the events older than `before`, records `audit.deleted` (appended first, so `seq` keeps counting even when nothing older survives) |

Pages are on the chain's `seq`, so a cursor never repeats or skips a row while others write. The
JSONL lines are exactly the list's items. `windkeel audit export --since 2026-10-01 > audit.jsonl`
follows the cursor; `windkeel audit verify` exits 1 on a broken chain.

**Tamper evidence.** Rows are a hash chain per account: `hash = sha256(prev_hash ||
canonical_json(row without hash))`. A trigger refuses `UPDATE`, `DELETE` and `TRUNCATE`; rows leave
only through `audit_event_purge` (retention, or a customer's deletion), which removes a prefix and is
recorded with the hash the surviving chain starts from.

**Retention.** 90 days unless the account sets `auditRetentionDays` (30–3650) or the deployment sets
`WINDKEEL_AUDIT_RETENTION_DAYS`. Customers may delete their own audit data (`DELETE` above).

**SIEM sink.** `WINDKEEL_AUDIT_WEBHOOK_URL` + `WINDKEEL_AUDIT_WEBHOOK_SECRET`: the hourly sweep POSTs
`{ accountId, events }` with `x-windkeel-timestamp` and `x-windkeel-signature: sha256=<hex HMAC-SHA256 of
"<timestamp>.<body>">`. At least once: dedupe on `id`.

## Account routes

An account route needs an **account role** (`account_membership`) holding its permission, narrowed by
any token; a token pinned to one organization is refused (`403`). An organization admin with no
account role gets `403 account_role_required`. The three permissions are Admin's and, like every admin
permission, are given to a token only when named.

| Route | Needs | Body / query | Answer |
| --- | --- | --- | --- |
| `GET /v1/account/roles` | `roles.manage` | | `{ items }`: built-ins (`builtIn: true`) and the account's own |
| `POST /v1/account/roles` | `roles.manage` | `{ name, key?, description?, permissions }` | `201 { role }`. `key` defaults to a slug of `name` |
| `PATCH /v1/account/roles/{id}` | `roles.manage` | `{ name?, description?, permissions? }` | `200 { role }` |
| `DELETE /v1/account/roles/{id}` | `roles.manage` | | `200`, or `409 role_in_use` while anyone holds it or a pending invitation offers it |
| `GET` / `PUT /v1/account/security-policy` | `account.manage` | `{ maxTokenTtlDays?, requireTokenExpiry?, idleSessionMinutes?, requireMfa?, ipAllowlist?, auditRetentionDays? }`; `null` clears a field | `{ policy }` |
| `GET /v1/account/access-review` | `audit.read` | `format=json\|csv` | Every principal, its role per organization, its account role, its live tokens (prefix, permissions, last use, expiry) |

**Custom roles.** A role's permissions must be a subset of its maker's (`400 invalid_scope`, naming
what is beyond); built-ins are `403 builtin_role`; another account's role is `404`. A member's role
(`POST /v1/members/{id}/role`, invitations, service principals) may be a built-in key, a custom key
or a role id; an unknown one is `404 role_not_found`. Assigning a role is refused when it holds more
than the assigner does here. Members holding a role get its new permissions on their next request.
`runs.merge` can go in a custom role ("Member + merge"); the merge route still refuses every token.

**Security policy** — each refusal is audited:

| Setting | Enforced | Refusal |
| --- | --- | --- |
| `maxTokenTtlDays` | every token minted (personal, service, device login) | none: a longer or missing expiry is **clamped** to the maximum; the response says `expiryClamped: true` |
| `requireTokenExpiry` | the same | `400 token_policy` for a token with no expiry when there is no maximum to give it |
| `ipAllowlist` | every request but the bootstrap token's | `403 ip_not_allowed`. The address is the trusted proxy header only: `x-vercel-forwarded-for`, or `WINDKEEL_CLIENT_IP_HEADER` |
| `requireMfa` | signed-in sessions | `403 mfa_required` unless the JWT's `aal` is `aal2` |
| `idleSessionMinutes` (5–43200) | signed-in sessions, by the JWT's `session_id` | `401 session_idle`: sign in again. A session with no `session_id` is `403 session_untracked` |

Nothing in the policy, a role or a token can switch the verifier off: no permission matches
`verif|bypass|skip` (`test/api-roles.test.js`).

## Reads

| | |
|---|---|
| `GET /v1/health` | Database reachability. No token. `503` with `database: "connection_limit"` when every pooled connection is taken, `"unreachable"` when the database doesn't answer. |
| `GET /v1/self` | Who this token is, and its scopes. |
| `GET /v1/queue` | Runs accepted and not yet working, **oldest first** — a queue is an order of service. |
| `GET /v1/metrics` | The ADR-0013 views, nulls intact. |
| `GET /v1/repositories` | Repositories Windkeel can work against, with each one's open-run count. |
| `GET /v1/tasks` | `?repository=` `?status=` `?source=` |
| `GET /v1/tasks/{id}` | Criteria, with provenance lifted out. |
| `GET /v1/tasks/{id}/runs` | Every run of one task. |
| `GET /v1/runs` | `?task=` `?repository=` `?batch=` (or `?batch_id=`) `?status=` — one state, or several comma-separated (`?status=WAITING_FOR_APPROVAL,BLOCKED`) |
| `GET /v1/runs/{id}` | The run report, plus the feed cursor to follow from, and `modelConfig`: the models intake froze the run to (below), or null before intake and on runs older than M9. |
| `GET /v1/runs/{id}/events` | The feed: state changes, cost, and the agent's own steps. `?after=` `?limit=` `?stream=sse`; read backwards with `?last=` / `?before=`, narrowed with `?kind=`. See [following a run](#following-a-run). |
| `GET /v1/events` | Which of the organization's runs moved: `run.changed` hints for re-reading a list. `?after=` `?stream=sse`. See [following an organization](#following-an-organization). |
| `GET /v1/runs/{id}/attempts` | The repair history, interleaved chronologically. |
| `GET /v1/runs/{id}/cost` | `{ totalUsd, unpricedEvents, byStage, bySource, spendCapUsd, runRowCost }`: per stage, kind and key source, and model spend by whose key paid. See [cost by key source](#cost-by-key-source). |
| `GET /v1/model-policy` | `?repositoryId=` — the organization default, or that repository's layer over it, with the organization's presets and the enabled harnesses. `models.read`. See [model policy](#model-policy). |
| `GET /v1/runs/{id}/diff` | The newest candidate's patch, inline, as the maker stored it. `?sha=` picks another; `candidates` lists them all. `409 no_candidate` before there is one, `409 no_patch` when it wasn't stored. |
| `GET /v1/runs/{id}/evidence` | One entry per verification: `stored`, `pruned`, or `never_produced`. |
| `GET /v1/runs/{id}/evidence/{path}` | `302` to a presigned URL, valid 5 minutes. |
| `GET /v1/runs/{id}/messages` | Guidance sent to this run, and whether the maker heard it. |
| `GET /v1/repositories/{id}/secrets` | A repository's secret **names**, notes and authorship. Never a value. |
| `GET /v1/runs/{id}/capture` | The files a capture stored, which outlive the sandbox for 30 days ([ADR-0015](adr/0015-evidence-retention-outcome-tiered-with-tombstones.md), amended). `state` is `stored`, `pruned` or `never_captured`, with `capturedAt`, `expiresAt`, `prunedAt` and `byteTotal`; a capture stored before migration 0037 is `stored` with null dates — the sweep does not know it. |
| `GET /v1/runs/{id}/capture/{path}` | `302` to a presigned URL, valid 5 minutes. `409 capture_pruned` once retention has removed the capture. |
| `GET /v1/runs/{id}/screenshots` | The maker's own screenshots (#392, ADR-0035): `{id, name, url, pageTitle, consoleErrors, capturedAt, bytes, evidence: false}`, in capture order. Maker-authored, unverified, never evidence. |
| `GET /v1/runs/{id}/screenshots/{sid}` | The PNG bytes, served by the API itself: `image/png`, `inline`, `nosniff`, `default-src 'none'`. `415 not_png` if the stored object is not a PNG; `503 storage_unconfigured` with no object store. |
| `GET /v1/runs/{id}/workspace` | `?path=` — the maker workspace, read-only, between turns: one directory level, or one file as text. See [reading the maker workspace](#reading-the-maker-workspace). |
| `GET /v1/sandboxes/reapable` | What the reaper would destroy now, and why. Destroys nothing. Account-wide, like metrics. |

Collections return `{ items, endCursor, hasNextPage }` — no total, because counting a filtered
table on every page is a cost nobody asked for. **Pagination is keyset, and `endCursor` is
opaque.** Do not parse it: a client that parses a cursor will eventually construct one, and then
the ordering columns can never change.

**Out of connections.** The API's functions reach Postgres through the Supavisor transaction
pooler (`DATABASE_POOL_URL`); `DATABASE_URL`, in session mode, is for migrations and the sweeps
that take advisory locks. When no connection is free, any route answers `503 connection_limit` with
`Retry-After: 2`. A read is safe to retry. A command may have failed after part of its work
committed, so read the run back before sending it again; the console retries reads once and never
retries a command. Each API and webhook pool closes connections idle for five seconds, and every
deployed pool lets Vercel close them before an instance is suspended (`apps/ingress/src/db-pool.ts`).

## Commands

Every run and task command answers **`202`**, never `200`, and carries the affected run plus a
cursor — so a client can start following without a race between "I started it" and "I began
watching".

The two secret writes, capture and reap are the deliberate exceptions and answer `200`. A `202`
means "a worker will act on this later", and nothing will: storing a secret *is* the row, and the
copy and the destroys have happened before the response. Using the one status that means "ask
again" for something already done would make it mean nothing.

| | |
|---|---|
| `POST /v1/tasks` | `{ repositoryId, title, description, riskLevel?, spendCapUsd?, wallClockCapSeconds?, models?, mode?, playbook? }` — writes the task and its run, and hands the run to the workflow. `models` is the task's layer of [model policy](#model-policy). `mode` is `autonomous` or `pair` ([take over](#take-over-hand-back-submit), behind `WINDKEEL_TAKEOVER`). `playbook` is a slug or id ([playbooks.md](playbooks.md)), snapshotted onto the task; `404 unknown_playbook` when there is none. Optional `Idempotency-Key` header, below. |
| `POST /v1/runs` | `{ taskId, spendCapUsd?, wallClockCapSeconds?, models? }` — refused `409` while any run of that task is live, except one still in `CREATED`, which is handed over again rather than duplicated (not when `models` is given: that run would not be this request's). `models` is *Run again with…*: see [model policy](#model-policy). |
| `POST /v1/runs/{id}/approve` | Same mechanism as `/windkeel approve`. |
| `POST /v1/runs/{id}/cancel` | `{ reason? }` — same mechanism as `/windkeel cancel`. |
| `POST /v1/runs/{id}/messages` | `{ message }` — guidance to a live maker. Answers `queued`. |
| `POST /v1/runs/{id}/takeover`, `/submit`, `/handback`, `/workspace/session` | `runs.takeover`, behind `WINDKEEL_TAKEOVER` — see [Take over, hand back, submit](#take-over-hand-back-submit). |
| `POST /v1/repositories/{id}/secrets` | `{ key, value, note? }` — **`200`**, see below. |
| `POST /v1/repositories/{id}/secrets/{key}/delete` | **`200`**, or `404` if there was no such name. |
| `POST /v1/runs/{id}/capture` | **`200`**: copies the maker sandbox's scratch directory into the evidence bucket and records it on `run_capture`, which starts (or restarts) its 30-day window. `409 capture_unavailable` with the reason when there is no sandbox to read. |
| `POST /v1/sandboxes/reap` | **`200`** with every outcome: runs the hourly reaper now, under its lock. `409 sweep_in_progress` if a tick holds it. |

**A created run is always handed over.** Both creating routes enqueue the run to the deployment,
exactly as the label path does. If that fails the answer is `503 enqueue_failed`, naming the task
and the run, not a `202` — the row exists and nothing is carrying it. `POST /v1/runs` with the task
id retries it. Until 2026-09-24 neither route enqueued anything, and a run created through the API
sat in `CREATED` for good.

**`Idempotency-Key` on `POST /v1/tasks`** (M8-5). An automation that retries a request it never saw
answered sends `Idempotency-Key: <≤200 printable ASCII characters>`. The key is claimed in the
delivery ledger (`intake_delivery`, `source = 'api'`, `delivery_key =
'{organizationId}:{principalId}:{key}'`) in the task's own transaction, with a SHA-256 of the
canonical body and the answer given.

- Same key, same body ⇒ **the original response, verbatim** (same `taskId`, `engineeringRunId`,
  `enqueued`), with `Idempotent-Replayed: true`. Nothing is re-derived: a grant withdrawn since, or
  a workflow outage, does not change the answer, and a replay is never a `503`. If the first
  request's hand-over failed (`503 enqueue_failed`), the replay answers the stored `202` with
  `enqueued: false` and, as a side effect, hands the still-`CREATED` run over again.
- Same key, different body ⇒ `422 idempotency_key_reused`. A malformed key ⇒ `400
  invalid_idempotency_key`.
- Keys are scoped per organization and per principal. They do not expire while the ledger keeps
  the row (acted rows are kept).

Caps default to the deployment's rails. There is no uncapped run through the API: a JSON `null` is
what a client sends when a field was left empty, not a decision to spend without limit.

**Capture and reap reach sandboxes**, which takes the sandbox token. They answer `503
sandbox_unconfigured`, naming the variable, when the deployment has none; capture also needs
`S3_BUCKET`. Why this API may hold that token when §1 said it would not is in ADR-0023's 2026-09-24
amendment.

A command that is refused answers **`409` with a reason**, not `202`. An approval window that has
closed, a run already terminal, a second run while one is in flight: all real refusals, and
reporting them as accepted would be the same lie as a `200` on a queued write.

**The App never merges, approves or marks ready.** Its `GitHubClient` has no method for any of
them ([ADR-0009](adr/0009-github-app-scope-for-milestone-6.md)). Merging from Windkeel is a capability
of the *person*, made with their own GitHub authorization — see
[merging as the person](#merging-as-the-person) (behind `WINDKEEL_MERGE=1`).

## Take over, hand back, submit

**Behind a flag, default off.** These exist only on a deployment with `WINDKEEL_TAKEOVER=1`
([ADR-0029](adr/0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md) §3–4, #369). With it off,
each answers `409 takeover_disabled` and `POST /v1/tasks` refuses `mode: "pair"` the same way. Not
for release until ADR-0029's flip conditions hold and the security audit signs off the token gate
and the push path.

Each is an intent under the same rules as every command — `202` with `{ accepted, engineeringRunId,
outcome, cursor }`, or a `409` naming why — and each needs **`runs.takeover`** (Admin and Member,
ADR-0024 as amended).

| Method and path | Does |
|---|---|
| `POST /v1/runs/{id}/takeover` | On `IMPLEMENTING` / `REPAIRING`: queues a take over, honoured at the **next turn boundary** — never mid-turn. The agent's work is committed and pushed as a candidate by the ordinary capture, the maker sandbox is *held*, and the run enters `HUMAN_EDITING`. On `PR_READY` / `WAITING_FOR_HUMAN` the same call is *Make changes*: a workspace on the verified PR's head. Answers `queued`. |
| `POST /v1/runs/{id}/submit` | Commits the person's changes as them and sends them to `VERIFYING` (a fresh verifier sandbox, unchanged — ADR-0004). On a run with a pull request, a passing verification updates the **same** PR (`PR_CREATING → PR_READY`). Answers `queued`. |
| `POST /v1/runs/{id}/handback` | Commits the same way; the maker fetches the commit and resumes with a turn that says what changed (`IMPLEMENTING`). Refused for *Make changes* (`no_maker`): the agent's sandbox ended when the PR opened. Answers `queued`. |
| `POST /v1/runs/{id}/workspace/session` | Mints the person's per-session capability token and starts (or wakes) the workspace's server with only its SHA-256. `202` adds `url` and `expiresAt`. |

| Refusal | When |
|---|---|
| `409 takeover_disabled` | `WINDKEEL_TAKEOVER` is off on this deployment. |
| `409 run_terminal` | The run has ended. |
| `409 not_takeover_state` | Take over outside `IMPLEMENTING` / `REPAIRING` / `PR_READY` / `WAITING_FOR_HUMAN` — including `VERIFYING`: wait for the verdict. |
| `409 already_editing` | A human session is already live on this run. |
| `409 human_cycle_cap` | `human_cycles` has reached `human_cycles_cap` (default 10). A person's cycles don't spend the repair budget; the spend cap still applies. |
| `409 no_github_identity` | The caller has no linked GitHub account. The commit is authored as `<id>+<login>@users.noreply.github.com`, so there must be one. |
| `409 not_editing` | Submit, hand back or session on a run that isn't `HUMAN_EDITING`. |
| `409 not_your_session` | Only the person editing may open, submit or hand back. Anyone with `runs.write` may still cancel. |
| `409 workspace_not_ready` | The workspace is still being set up (install runs, without repository secrets, before anyone gets it). |
| `409 intent_pending` | A submit or hand back is already on its way. |
| `409 no_maker` | Hand back on a *Make changes* session. |
| `503 sandbox_unconfigured` | The session route can't reach the sandbox provider. |

**The capability token** (ADR-0029 §4, Spike A). 256 random bits, minted in the API for one
principal and one session; the workspace server holds only its SHA-256, and the API stores neither.
`url` is `https://<sandbox>/__windkeel/open#t=<token>` — **the token is only ever in the fragment**,
which a browser never sends, and the page exchanges it once (single-use) for a `__Host-`, HttpOnly,
Secure, SameSite=Strict cookie on the sandbox's own origin. The response is `cache-control:
no-store` and is never logged. Clients open it **in a new tab**; the server sends `frame-ancestors
'none'`, so it can't be embedded. Every wake restarts the server with a fresh token, so the
console asks again after the workspace has slept. Submit, hand back and cancel stop the server,
which revokes it.

**What is in the human workspace, and what is not.** A new sandbox clones at the run's base and
fetches the candidate through git (as the verifier does); a read-only git credential is used for
that fetch and removed — and scrubbed from `.git` wherever the platform clone kept it — before
anything else runs. The install runs **without repository secrets** (ADR-0029 §3.4 as amended): the
person gets root in the VM next, so nothing the install saw may be a secret. A repository whose
install needs one gets a workspace without those dependencies, and `takeover.session.installNote`
says so (*Installed without repository secrets — private dependencies may be missing.*). Egress is
the install allowlist. **No model key, push token, git credential, repository secret or checker
credential is ever in it.** The workspace sleeps after 30 idle minutes and is
deleted when the run leaves `HUMAN_EDITING` or after 24 h.

**How the person's commit leaves** (ADR-0029 §3.6, Spike B). Submit and hand back stop the person's
processes, build one commit with `commit-tree` (parent: the seed candidate; author: the person's
GitHub noreply identity, never `WINDKEEL_GIT_AUTHOR_EMAIL`; no hooks), and read it out as a git bundle.
The API host checks the bundle — exactly one commit, its parent the seed, not authored as Windkeel —
pushes it with a just-in-time installation token, and revokes the token (`DELETE
/installation/token`) as soon as the push returns, on failure too. The push lands only if the run
branch still holds the seed: it is leased on it (`--force-with-lease=refs/heads/<branch>:<seed>`), so
a branch deleted or rewound after the check is refused, not recreated. The verified SHA is recorded
on the session before the push, so a redelivery that finds the branch already at it treats the push
as landed.

**A takeover that misses its boundary.** The API accepts a takeover under the run's row lock, and
the maker's turn boundary reads it under the same lock. One accepted after the boundary read is
expired when the run leaves `IMPLEMENTING` / `REPAIRING` for anything but `HUMAN_EDITING`:
`takeover.session` shows `state: "ended"`, `outcome: "expired"` and the error *The turn ended
before Windkeel could stop — take over again.*

**A *Make changes* candidate that fails verification** stops at `BLOCKED`, not `REPAIRING`: the
maker ended when the pull request opened, and a repair turn is a resumed turn on its session
(ADR-0011 §2, ADR-0017 §3), so there is none to take. The failing candidate is on the PR branch and
the evidence says what failed.

**Pair mode.** `POST /v1/tasks` takes `mode: "autonomous" | "pair"` (default `autonomous`); task
rows carry `sessionMode`. *Pair* stops after the first implementing turn and enters
`HUMAN_EDITING`. Neither mode changes verification. `mode: "pair"` needs what an explicit take
over needs, checked when the task is created: `runs.takeover` (`403 forbidden`, `missing:
"runs.takeover"`) and a linked GitHub identity (`409 no_github_identity`).

**On the run read.** `GET /v1/runs/{id}` adds, beside `report`:

```json
"takeover": {
  "enabled": true,
  "session": { "id": "…", "state": "ready", "origin": "takeover",
               "editor": { "principalId": "…", "login": "octocat", "displayName": "The Octocat" },
               "yours": true, "awake": true, "requestedAt": "…", "startedAt": "…",
               "lastActiveAt": "…", "expiresAt": "…", "seedSha": "…", "intent": null,
               "error": null, "canHandBack": true },
  "cycles": { "used": 1, "cap": 10 }
},
"candidates": [
  { "sha": "…", "parentSha": null, "at": "…", "commitAuthor": "maker", "provenance": "maker",
    "maker": { "harness": "codex", "model": "gpt-5" }, "person": null },
  { "sha": "…", "parentSha": "…", "at": "…", "commitAuthor": "person", "provenance": "mixed",
    "maker": null, "person": { "login": "octocat", "principalId": "…" } }
]
```

`session.state` is `requested`, `provisioning`, `ready`, `sleeping`, `submitting`, `handing_back`,
`ended` or `failed`. `candidates` are oldest first; `provenance` is who wrote the candidate as a
whole since the base (`mixed` when both did), and the evidence package's author provenance says the
same. `takeover.enabled` mirrors the flag; `GET /v1/self` carries it as `features: { takeover }` so
a client can offer Pair mode before there is a run.

## Merging as the person

[ADR-0029 §5](adr/0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md),
#371. **Off twice over:** every route below answers `404 merging_disabled` until the deployment sets
`WINDKEEL_MERGE=1`, and nothing merges until an organization admin turns on *Allow merging from Windkeel*
(`organization.allow_merge`, default `false`). Not for release until ADR-0029's flip condition 2 (a
live run of Spike C's harness) is met.

| Method and path | Needs | Answers |
|---|---|---|
| `GET /v1/merging` | `runs.read` | `{ allowMerge, canManage, canMerge, githubConnect: { configured }, authorization }` — the organization's setting and **your** authorization |
| `PUT /v1/merging` | `members.manage` | `{ allowMerge: boolean }` ⇒ `200 { allowMerge }` |
| `GET /v1/github-authorization` | any credential | `{ authorization }`: GitHub login and id, `status` (`valid` \| `needs_reauth`), expiries. Never a token |
| `POST /v1/github-authorization` | a session | `{ code, codeVerifier, redirectUri? }` from the console's callback ⇒ `201 { authorization }`. `409 github_account_mismatch` when the token's GitHub account isn't the one you sign in with (the token is revoked), `400 github_authorization_failed`, `503 github_authorization_unconfigured` / `secrets_disabled` |
| `DELETE /v1/github-authorization` | a session | `200 { deleted }`. Revoke the grant itself on github.com |
| `GET /v1/runs/{id}/merge-eligibility` | `runs.read` | `{ eligible, rules: [{ id, ok, blocking, checked, reason }], failing, needsAcknowledgement, verifiedSha, verdict, verdictDigest, prNumber, prUrl, isDraft, authorization, merge, githubError }` |
| `POST /v1/runs/{id}/merge` | `runs.merge`, a session | `{ acknowledgements?: [itemId], markReady?: boolean, mergeMethod?: "squash" \| "merge" \| "rebase" }` ⇒ `202 { merge }`. `409 merge_refused` with `rule` and `rules`, `409 merge_in_progress`, `502 github_unavailable`, `503 merge_unavailable` |

**The rules**, each reported true or false with its reason, in this order: `enabled` (`WINDKEEL_MERGE`),
`pr-open`, `head-verified` (the PR's head is the verdict of record's candidate), `verdict` (`pass` or
`warn`), `warn-acknowledged` (on `warn`, every *Needs a look* item ticked), `permission`
(`runs.merge`), `org-allows`, `draft` (only with `markReady: true`), `workflows` (a PR touching
`.github/workflows/*`, or whose file list is truncated, is refused: *merge it on GitHub*),
`protection` (GitHub's `mergeStateStatus` must be `CLEAN`, `HAS_HOOKS` or `UNSTABLE`; `BLOCKED` is
refused even for an admin who could bypass), `bypass` (ADR-0029 §5.1, amended: Windkeel refuses to merge
as anyone GitHub reports can bypass the repository's protection — `viewerCanMergeAsAdmin` true, or an
active ruleset on the base branch answering `current_user_can_bypass` `always`, `pull_requests_only`
or `exempt` — because a review dismissed or a check failing between the read and the `PUT`, without the
head moving, would merge on their bypass; the fix is *Do not allow bypassing the above settings*, or an
empty ruleset bypass list), and `authorization` (you connected GitHub, it is
`valid`, and its GitHub account is the one you sign in with). `GET …/merge-eligibility` judges the PR
as the App reads it — the App can't read the *person's* bypass, so there `bypass` is `checked: false`
and not blocking, unless your last attempt at this candidate was refused for it (then it says so, still
not blocking, since the next merge checks afresh) — a warn as if each item will be ticked (they come back as `needsAcknowledgement`),
and a draft as *Mark ready and merge*.

**What a merge does.** `POST …/merge` judges every rule again with what was sent, records a
`run_merge` row (`pending`: principal, PR, the verified SHA, the verdict of record and its digest, the
acknowledged items) and starts a one-step workflow (`merge-flow.ts`) by the row's id. On the stage
side that step reads the rules again from Postgres, opens your token — refreshing it under a row lock
if it expires within five minutes, storing the new pair in the same transaction, and marking the
authorization `needs_reauth` if GitHub refuses — checks with `GET /user` that the token is still you,
reads the PR **with your token** (GraphQL `mergeStateStatus`, `viewerCanMergeAsAdmin`, the files, and
`GET …/rules/branches/{base}` then each ruleset's `current_user_can_bypass`; a ruleset that doesn't
say counts as unknown and refuses),
marks a draft ready (`markPullRequestReadyForReview`) and judges again, then merges with REST
`PUT …/merge` and `sha` = the verified candidate, so GitHub itself refuses (`409`) if the head moved.
The row ends `merged` (with GitHub's merge SHA), `refused` or `failed`, with the reason; the next
`GET …/merge-eligibility` carries it as `merge`. The run reaches `COMPLETED` when GitHub's
`pull_request.closed` arrives, exactly as for a merge made on GitHub. A row still `pending` fifteen
minutes after it was asked for — its step died — is settled `failed` by the periodic sweep
(`sweeps/stale-merges.ts`, on `/api/sweep`), with a reason that says to check the pull request on
GitHub; a new merge of the run can then be asked for.

**Tokens.** A GitHub App user-to-server token and its refresh token are sealed separately (sealed box
v2, contexts `github_user_token:<principal>:<github user>:access|refresh`) in
`github_user_authorization`. Ingress seals and cannot open; only the merge step opens, and no
response, row other than that one, step argument or log carries a token. Merging as the person adds
no commit to the pull request, so ADR-0013's `human_commits_after_pr` is unchanged by it.

**Grantable to Member — not yet.** Built-in roles are global rows and Windkeel has no per-organization
role customization, so `runs.merge` is Admin's only. An account-scoped `access_role` row is where a
grant to Member would go.

## Reading the maker workspace

`GET /v1/runs/{id}/workspace?path=` (`runs.read`, [ADR-0029](adr/0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md) §2, #366) is the console's
*Files* tab: a read-only look into the maker's checkout. `path` is relative to the checkout root;
omitted or empty is the root.

```json
{ "engineeringRunId": "…", "kind": "directory", "path": "src", "truncated": false,
  "entries": [{ "name": "lib", "path": "src/lib", "type": "directory", "bytes": null },
              { "name": "index.ts", "path": "src/index.ts", "type": "file", "bytes": 812 }] }
{ "engineeringRunId": "…", "kind": "file", "path": "src/index.ts", "bytes": 812, "content": "…" }
```

A directory is **one level**, directories first, cut at 1,000 entries (`truncated`). `type` is
`file`, `directory`, `symlink` or `other`; a symlink is listed as one, never followed in a listing.
The root's `.git` is not listed. A file is UTF-8 text, verbatim. Responses are `no-store`.

**Everything it returns is the agent's.** The maker is untrusted code with a shell (ADR-0014): it
chose every name and byte. Render it as escaped text and never execute it, which is what the
console does.

| Refusal | When |
|---|---|
| `400 invalid_path` | An absolute path, `..`, a backslash, a control character, or `.git` — including a symlink that resolves into `.git`. Checked before anything is attached. |
| `400 path_escapes` | The path resolves outside the checkout: a symlink to `/etc`, to the agent's scratch directory, anywhere. Resolved inside the sandbox with `realpath`; not followed. A dangling symlink is refused the same way. |
| `400 not_a_file` | Neither a regular file nor a directory (a FIFO, a device). Never opened. |
| `404 not_found` | No such path. |
| `413 file_too_large` | Over 1 MiB. The body names `bytes` and `cap`. |
| `415 binary_file` | A NUL byte, or bytes that aren't UTF-8: `"binary, N bytes"`, with `bytes`. Never decoded lossily. |
| `409 turn_running` | The run is in `IMPLEMENTING` or `REPAIRING`. A turn is the agent writing the tree, so a mid-turn read is a tree no one ever had and a half-written file reads as finished; those states also hold the candidate capture, the one moment a write-scoped git credential is on the sandbox's disk. Readable again in `VERIFYING` (the maker is idle while the verifier works, ADR-0017) and after. The state and the run's latest transition are re-read just before and just after the sandbox command; if the run moved at all during the read, the result is discarded and this is the answer. Retry. |
| `409 run_terminal` | The run has ended; its maker is torn down when it does. |
| `409 no_workspace` | No maker sandbox yet (before `IMPLEMENTING`), or none recorded. |
| `409 workspace_gone` | The maker workspace is no longer `ready` (destroyed, reaped), or attaching to it failed. A destroyed workspace isn't looked for. |
| `409 workspace_unreachable` | Its provider isn't configured here, or can't reattach. |
| `503 sandbox_unconfigured` | The deployment reaches no sandbox provider, as for capture and reap. |

**How it reads.** Like capture, it attaches to the maker by stored handle, which takes the sandbox
token: the same bend of ADR-0023 §1 that its 2026-09-24 amendment made for capture and reap, for
the same reason — the bytes exist only in the sandbox. Each
read is one short `sh -c` through the provider's command API, the path passed in an environment
variable, never in the script's text. **No port, PTY or server is ever started in a maker
sandbox**; nothing is written. The checks run with the sandbox's own `realpath`; an agent that
reached root could replace it, but that agent could already print any file into its own feed, so
the read shows a viewer nothing more (the root residual ADR-0014's 2026-10-16 amendment states).

## Batches

One ask fanned out into many runs (#391, [ADR-0036](adr/0036-batches-group-verified-runs-and-never-gate-them.md)).
A batch is **grouping, scheduling and a roll-up only**: every child is an ordinary task and run
with its own rails, its own independent verification and its own draft pull request. There is no
batch merge, approve, mark-ready or aggregate verdict, and no route here can make one. The whole
model is in [batches.md](batches.md).

| | Permission | Body ⇒ answer |
|---|---|---|
| `POST /v1/batches` | `batches.manage` | `{ kind: "fanout" \| "multi_repo", title, description, repositoryId? + items?: [{ title, description, criteria? }], repositories?: [id], criteria?: [text], riskLevel?, maxConcurrency? (1–50, default 3), batchSpendCapUsd? (default 100), uncappedConfirmed?, stopOnFailureRatio? (0–1], spendCapUsd?, wallClockCapSeconds? }` ⇒ `202 { accepted, batchId, started, batch, items }`. Optional `Idempotency-Key`. |
| `GET /v1/batches` | `runs.read` | `?status=` `?cursor=` `?limit=` ⇒ a page of batches, each with `progress` |
| `GET /v1/batches/{id}` | `runs.read` | `{ batch, items }` — `progress`: counts by child state (`byStatus`), `verdicts`, `succeeded`, `failed`, `active`, `pending`, `skipped`, `totalCostUsd` (= SUM of the children's `engineering_run.cost`), `reservedUsd`, `remainingBudgetUsd`; each item with its run, verdict, cost and pull request |
| `POST /v1/batches/{id}/pause` · `/resume` · `/cancel` | `batches.manage` | `202 { batch, items }`; `cancel` also answers `cancelled: [{ runId, outcome }]` — every child still working, cancelled through the ordinary run-cancel path (a child whose verified pull request waits on a reviewer is left alone) |

| Refusal | When |
|---|---|
| `400 missing_field` / `invalid_field` | A field is absent or the wrong shape; the message names it |
| `422 no_items` | A fanout batch with no items, a multi_repo batch with no repositories |
| `422 too_many_items` | More than `WINDKEEL_BATCH_MAX_ITEMS` (default 200); answers `maxItems` |
| `422 repository_not_granted` | A repository the organization holds no grant on; answers `ungranted: [id]` |
| `422 uncapped_batch` | `batchSpendCapUsd: null` without `uncappedConfirmed: true` (ADR-0011's rule, for the batch) |
| `422 invalid_concurrency` | `maxConcurrency` not a whole number from 1 to 50 |
| `409 invalid_batch_state` | Pausing what is not running, resuming what is not paused, cancelling what has settled |

## Webhook endpoints

Signed inbound webhooks let any system start a task without a Windkeel token (M8-5; the wire
contract is [`webhook-intake.md`](webhook-intake.md)). Every route needs `integrations.manage` —
the list too, because an endpoint id is half of what it takes to address one.

| | |
|---|---|
| `GET /v1/webhook-endpoints` | The organization's endpoints: `{id, name, repositoryId, enabled, defaultRiskLevel, secretVersion, path, createdAt, rotatedAt}`. Never a secret. |
| `POST /v1/webhook-endpoints` | `{ name, repositoryId, defaultRiskLevel?, enabled? }` — **`201`** with `{endpoint, secret}`. The repository must be granted to the organization (`422 repository_not_granted`). |
| `PATCH /v1/webhook-endpoints/{id}` | `{ name?, enabled?, defaultRiskLevel? }` — `200 {endpoint}`. |
| `DELETE /v1/webhook-endpoints/{id}` | `200 {deleted}`. |
| `POST /v1/webhook-endpoints/{id}/rotate` | Bumps `secretVersion`; every earlier secret stops verifying at once. `200 {endpoint, secret}`. |

**The secret (`whsec_…`) is answered by create and rotate, once**, and never stored: it is derived
from the deployment's `WINDKEEL_WEBHOOK_SIGNING_KEY` and the endpoint's id and version. Without that
variable, or with one shorter than 32 bytes, create and rotate answer `503
webhook_signing_unconfigured`; reads and the other writes still work. These are `200`/`201`, not
`202`, for the reason the secret writes are: the row is the whole of the work.

## Milestone 8 at a glance

Every endpoint M8 added, in one place. The details live in the sections above and in the linked
pages; this table is the index.

| Endpoint | Needs | Answers | Detail |
| --- | --- | --- | --- |
| `POST /v1/tasks` + `Idempotency-Key` | `runs.write` | `202`; a replay with the same key and body answers the original `202` with `Idempotent-Replayed: true`; the same key with another body is `422 idempotency_key_reused` | [Commands](#commands), [webhook-intake.md](webhook-intake.md) |
| `GET /v1/service-principals`, `POST`, `DELETE …/{id}` | `tokens.manage` | `{items}` (system actors included, `system: true`); `201 {servicePrincipal}`; `200` | [Service principals](#service-principals) |
| `GET` / `POST /v1/service-principals/{id}/tokens`, `DELETE …/tokens/{tokenId}` | `tokens.manage` | `201 {token, secret}` — the secret once | [Service principals](#service-principals) |
| `GET /v1/integrations` | **`runs.read`** | `{items}`: each connection with its `routes` | [Integrations](#integrations) |
| `POST /v1/integrations` | `integrations.manage` | `201 {connection}` (`200` when this organization already holds it) | [Integrations](#integrations) |
| `DELETE /v1/integrations/{id}` | `integrations.manage` | `200 {connection}`, disconnected | [Integrations](#integrations) |
| `POST /v1/integrations/{id}/routes`, `PATCH` / `DELETE …/routes/{routeId}` | `integrations.manage` | `201 {route}`, `200 {route}`, `200 {deleted}` | [Integrations](#integrations) |
| `GET /v1/schedules`, `GET /v1/schedules/{id}`, `GET /v1/schedules/preview` | `runs.read` | a page of schedules; one schedule; the next fire times | [schedules.md](schedules.md) |
| `POST /v1/schedules`, `PATCH` / `DELETE /v1/schedules/{id}` | `schedules.manage` | `201`, `200`, `200` | [schedules.md](schedules.md) |
| `POST /v1/schedules/{id}/fire` | `schedules.manage` | `202 {accepted, taskId, engineeringRunId, enqueued}`; `409 run_in_flight` / `run_requeued` | [schedules.md](schedules.md) |
| `GET /v1/webhook-endpoints` | **`integrations.manage`** | `{items}`, never a secret | [Webhook endpoints](#webhook-endpoints) |
| `POST /v1/webhook-endpoints`, `POST …/{id}/rotate` | `integrations.manage` | `201` / `200 {endpoint, secret}` — the secret once | [Webhook endpoints](#webhook-endpoints) |
| `PATCH` / `DELETE /v1/webhook-endpoints/{id}` | `integrations.manage` | `200 {endpoint}`, `200 {deleted}` | [Webhook endpoints](#webhook-endpoints) |
| `GET /v1/model-credentials[?include=revoked]` | `models.read` | `{items}`, never a value | [Model credentials](#model-credentials) |
| `POST /v1/model-credentials`, `PUT …/{id}` | `models.manage` | `201` / `200 {credential, validation}`; `503 secrets_disabled` without a public key | [Model credentials](#model-credentials) |
| `DELETE /v1/model-credentials/{id}` | `models.manage` | `200 {credential}`, revoked | [Model credentials](#model-credentials) |
| `POST /v1/model-credentials/{id}/validate` | `models.manage` | `202 {accepted, credential, validation}` | [Model credentials](#model-credentials) |

**Note the two list permissions.** `GET /v1/integrations` needs only `runs.read`, while `GET
/v1/webhook-endpoints` needs `integrations.manage`. That is deliberate and stays: a member may see
which workspaces feed the organization and where their work goes, but an endpoint id is half of
what it takes to address a signed webhook (the other half is its secret), so only an admin lists
them. The console's settings tabs follow the same rule.

### Integrations

Slack, Linear and Jira workspaces connected to the organization, and where their work goes
(ADR-0025 §2; the operator's view is [integrations.md](integrations.md)).

| | |
|---|---|
| `GET /v1/integrations` | `{items}`: `{id, provider, installationId, externalTenantId, externalTenantName, status, createdByPrincipalId, createdAt, disconnectedAt, routes: [{id, scopeKind, scopeValue, repositoryId, triggerLabel, enabled, createdAt}]}`. |
| `POST /v1/integrations` | `{ provider: "slack" \| "linear" \| "jira", installationId }`. The deployment asks Connect who the installation is, stores the tenant id and name, and discards the token. For Jira, the site's webhook is (re)registered afterwards. **Sentry** (#389, ADR-0034) is not carried by Connect: `{ provider: "sentry", externalTenantId: "<installation uuid>", orgSlug?, token? }`; a `token` is sealed with `WINDKEEL_SECRET_PUBLIC_KEY` (`503 secrets_disabled` without it) and answered only as `credential: {last4, updatedAt}`. |
| `DELETE /v1/integrations/{id}` | Marks it `disconnected` (the row stays as history; the workspace is free to connect elsewhere). For Jira, its webhooks are deleted at Jira too, best effort. |
| `POST /v1/integrations/{id}/routes` | `{ repositoryId, scopeKind?: "default" \| "slack_channel" \| "linear_team" \| "jira_project" \| "sentry_project", scopeValue?, triggerLabel? (default "orqon"), enabled? }`. |
| `PATCH /v1/integrations/{id}/routes/{routeId}` | `{ repositoryId?, triggerLabel?, enabled? }` — a route's scope is its identity and does not change. |
| `DELETE /v1/integrations/{id}/routes/{routeId}` | Removes it. |

Refusals: `409 tenant_claimed` (another organization holds that workspace), `422
integration_not_connected` / `tenant_unknown` (Connect has no usable installation, or did not say
which workspace it is), `422 repository_not_granted`, `409 route_exists`, `503
integration_misconfigured` (the provider's `WINDKEEL_CONNECT_*` is unset, or the connector is not
linked) and `503 integrations_disabled`. These are `200`/`201`, not `202`: the row is the work.

### The intake routes (not `/v1`)

Sources that are not API callers land on the ingress beside `/api/webhook` (GitHub). Each verifies
its own signature over the raw body before anything is parsed; none takes an `orq_` token.

| Route | Verified by | Notes |
| --- | --- | --- |
| `POST /api/intake/slack` | Vercel Connect OIDC bearer | Slash commands (answered `200` with an ephemeral body) and `app_mention` events |
| `POST /api/intake/linear` | Vercel Connect OIDC bearer, 5-minute `webhookTimestamp` window | `Issue` events |
| `POST /api/intake/jira` | HS256 JWT under `WINDKEEL_JIRA_WEBHOOK_SECRET` | `503` while the secret is unset |
| `POST /api/intake/webhook/{endpointId}` | HMAC-SHA256 with the endpoint's secret, 5-minute window | `202 {taskId, engineeringRunId}`; the wire contract is [webhook-intake.md](webhook-intake.md) |
| `/api/schedules` | `CRON_SECRET` bearer (fails closed) | Vercel cron, every 5 minutes. Also the batch dispatcher's safety net ([batches.md](batches.md)) |

An unknown source is `404` before the database is touched; a body over 1 MiB is `413`. Every
delivery that gets past verification is an `intake_delivery` row — including the ignored ones,
each with its reason — and a duplicate delivery is answered without a second task.

## Repository secrets

What they are for: a repository whose dependencies come from a private registry. Without a
credential the install fails, the verifier runs the repository's own checks against a tree with no
packages, and the verdict is about the factory rather than the candidate.

```bash
windkeel secret set "$REPO_ID" NPM_TOKEN @/tmp/token --note "read-only, rotates 2027-01"
windkeel secrets "$REPO_ID"
windkeel secret rm "$REPO_ID" NPM_TOKEN
```

**A value cannot be read back, and not because an endpoint declines to.** The stored value is sealed
to an X25519 public key (`WINDKEEL_SECRET_PUBLIC_KEY`); only the workflow steps open it, with
`WINDKEEL_SECRET_PRIVATE_KEY`. No API route imports anything that opens a value —
`test/api-routing.test.js` fails the build if one does — so there is no route that could return
one, and the database alone holds only ciphertext. Run `windkeel-admin secrets keygen` to mint the pair.
Since #213 both halves are in the one deployment's environment, so this separates the code path and
the database from a value, **not** code execution inside the deployment; ADR-0026's Consequences
state that residual risk, and [running-the-factory.md](running-the-factory.md#rotating-the-key-pair)
how to rotate the pair.

Where a secret goes: the environment of the dependency install command, in **both** the maker's and
the verifier's sandbox, and nowhere else in either sandbox's life. It is not set for the agent's
commands or for the repository's checks. The trade — a registry credential cannot be brokered at an
egress proxy the way a model key can — is recorded in
[ADR-0014 §5](adr/0014-sandbox-secrets-brokered-keys-scoped-tokens-phased-egress.md), together with
what a compromised sandbox now reaches.

Names are refused if they would shadow a brokered credential (`CODEX_API_KEY`, `OPENAI_API_KEY`, …),
name infrastructure no sandbox reaches (`DATABASE_URL`, `S3_*`), redirect an interpreter (`PATH`,
`NODE_OPTIONS`, `LD_PRELOAD`, …), or start with `WINDKEEL_`. The refusal says which rule and why.

Rotating the key pair does not re-seal what is stored. Set the old private half on the stage
deployment as `WINDKEEL_SECRET_PREVIOUS_PRIVATE_KEY` while you do (ADR-0026 §2): values sealed to either
pair keep opening until they are set again. Without it every existing secret becomes unopenable and
has to be set again. `windkeel-admin doctor` fails naming each one, and the install's own detail records
which names were **not** injected — because the alternative is a registry `401` whose message never
mentions a secret.

## Model credentials

An organization's own model keys ([ADR-0026](adr/0026-byok-org-sealed-model-credentials-and-a-per-run-model-snapshot.md)
§1–3). `models.read` lists them; `models.manage` (org admin) stores, rotates and revokes them.

```bash
windkeel models credentials add --provider openai --label prod < key.txt
windkeel models credentials add --provider openai-compatible --label vllm \
  --base-url https://llm.example.com/v1 --vendor meta --from-env VLLM_KEY
windkeel models credentials list
windkeel models credentials rotate "$CREDENTIAL_ID" --from-env OPENAI_API_KEY
windkeel models credentials revoke "$CREDENTIAL_ID"
```

- **Sealed like a repository secret, with the organization bound in.** The value is sealed by
  ingress to `WINDKEEL_SECRET_PUBLIC_KEY` in the v2 format, whose additional data is
  `model_credential:<organization>:<id>` — a ciphertext moved to another row fails to open. No
  response carries a value: a credential is its label, provider, `baseUrl`, last four characters and
  status. The CLI takes the key on stdin or `--from-env`, never as a flag or argument.
- **Checked where it can be opened.** A new or rotated credential is `unverified` and a check is
  started in a workflow step (a one-step workflow, `credential-flow.ts`), the only code that holds
  the private key: it opens the value,
  calls the provider's `GET /models` (OpenRouter: `GET /key`), and writes `valid` or `invalid` with a
  reason built from the status code — never the response body. A rate limit, outage or network error
  leaves it `unverified` with the reason. `POST …/{id}/validate` starts the check again, and so
  does the hourly sweep (`/api/sweep`) for any credential `unverified` and untouched for 15 minutes
  and less than 7 days old. `windkeel-admin doctor` counts credentials by status and warns on `invalid`
  ones and on any still `unverified` after an hour.
- **The console does all of this too.** Settings → Models lists the keys, adds, rotates, re-checks
  and revokes them (`models.manage`; members see it read-only), and edits the default maker and
  checker; a repository's page edits its override. The key goes from the form to the API in one
  server action and is never held in the page or echoed. A run's page shows its frozen snapshot.
- **`baseUrl` must be public https.** Refused: plain http (except `localhost` with
  `WINDKEEL_ALLOW_LOCALHOST_MODEL_BASE_URL=1`, for development), userinfo, a query, and any host that
  resolves to a private, loopback, link-local, metadata or otherwise reserved address. The check runs
  again at connect time, so a name that later re-resolves somewhere private is refused then too.
- **Revoking is final.** The row stays as the record; its ciphertext is overwritten, and the label is
  free for a new credential.

## Model policy

Which model each role runs on, and on whose key ([ADR-0026](adr/0026-byok-org-sealed-model-credentials-and-a-per-run-model-snapshot.md)
§4–6). Three layers, each optional: the **organization** default, a **repository** override
(`?repositoryId=`), and the **task**'s own `models` on `POST /v1/tasks`. Under all three are the
operator's models and keys — what every run used before M9, and still what a run gets when nothing
is configured.

```bash
windkeel models policy set --role maker --provider openrouter --model openai/gpt-5-codex --credential "$ROUTER_ID"
windkeel models policy set --role checker --provider openrouter --model anthropic/claude-sonnet-4.5 --credential "$ROUTER_ID"
windkeel models policy show [--repo "$REPO_ID"]
windkeel models policy clear [--role maker|checker] [--repo "$REPO_ID"]
windkeel submit … --maker-model openai/gpt-5 --checker-model anthropic/claude-opus-4.1
```

| | Needs | |
|---|---|---|
| `GET /v1/model-policy[?repositoryId=]` | `models.read` | `{ repositoryId, items, presets, harnesses }` — the organization layer, or that repository's rows and the default beneath them; the organization's [presets](#presets); and the maker harnesses this deployment enables. |
| `PUT /v1/model-policy[?repositoryId=]` | `models.manage` | `{ maker?, checker? }`, each `{ model, provider?, credentialId?, declaredVendor? }` and the maker also `harness?`, replacing that role at this layer. `credentialId` absent or `null` is Windkeel-managed; `harness` absent or `null` inherits. **`200`**: the row is the work. Both roles are checked before either is written. |
| `DELETE /v1/model-policy[?repositoryId=][&role=]` | `models.manage` | Clears the layer, or one role of it. `200 { deleted }`. |

Each item is `{ id, repositoryId, role, provider, model, credentialId, keySource, declaredVendor,
harness, updatedByPrincipalId, createdAt, updatedAt }`. It names a credential by id; nothing in this API
reads, returns or could return a key. Members get `models.read` so they can see what a task would
otherwise run on; only admins change it.

**A task's `models`** is `{ maker?, checker? }`. Each is a model name — only the model changes, the
provider and credential are inherited from the layer beneath — or an object as above, which replaces
that layer's choice. `checker` may be a list of one to five, in preference order. The shape and the
credential's organization are checked when the task is created; whether the whole resolves is
intake's question, because a credential can be revoked in between.

**The harness** ([ADR-0027](adr/0027-the-maker-harness-is-chosen-with-the-maker-model-and-frozen-per-run.md) §1,
§2, §4). A maker policy row and a task's (or re-run's) `models.maker` may name the **`harness`** that
drives the maker: `codex` or `claude-code`. The most specific layer that names one wins; a layer that
names only a model inherits it from below, down to `WINDKEEL_DEFAULT_MAKER_HARNESS`. A checker row with
a harness is `400 invalid_model_policy`; one the deployment does not enable is `422
harness_unavailable`; a harness that cannot call the row's provider is `422 harness_incompatible`
(Codex calls `openai`, `openrouter`, `openai-compatible`; Claude Code calls `anthropic` only). The
same checks run at intake on the resolved pair, where a refusal fails the run with `stopReason:
"model_policy"` rather than running it on another agent — including a harness the operator disabled
after a policy named it. The run's snapshot freezes `maker.harness: { id, version }`; a run never
changes harness, and a deployment that no longer registers it fails the run at its next maker stage.

**Run again with…** ([ADR-0029](adr/0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md) §6).
`POST /v1/runs` takes `models` in the same shape, checked the same way. It is the **new run's** own
choice (`engineering_run.model_override`), laid over the task's per role at intake and frozen into
that run's snapshot, where it shows as `source: "run"`. The task's own `models` are unchanged, and so
is every other run. **Nothing changes the models of a run that exists**: changing them is a new run
(ADR-0003, ADR-0011 §2, ADR-0026 §4). Because a role left out inherits the **task's** choice, the
console's dialog sends every role and the harness explicitly (the organization default materialized
into them); only its labelled *Same models as this task* sends no `models`.

**Harnesses.** `harnesses` on the policy read is `[{ id, label, default }]`, from
`WINDKEEL_MAKER_HARNESSES` (default `codex`) and `WINDKEEL_DEFAULT_MAKER_HARNESS`. The console renders its
Agent picker only when there is more than one.

**Refusals** never quote a value: `400 invalid_model_policy` (a provider not in the catalog, a
malformed model, a model whose vendor cannot be worked out — name it with `declaredVendor`, a
credential for another provider), `404 credential_not_found` (including another organization's),
`409 credential_revoked`, `409 credential_invalid`, `422 harness_unavailable`, `422
harness_incompatible`.

### Presets

An organization's own names for a harness + maker + checker pairing — *Fast*, *Thorough* — which the
console's composer offers before the raw models ([ADR-0029](adr/0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md) §6).
Windkeel ships none. A preset is a shortcut, not a layer: choosing one copies its choices into the
task's (or a re-run's) `models`, so editing or deleting it later changes no task and no run.

| | Needs | |
|---|---|---|
| `GET /v1/model-policy/presets` | `models.read` | `{ items }`. Also on `GET /v1/model-policy` as `presets`. |
| `POST /v1/model-policy/presets` | `models.manage` | `{ name, harness?, maker, checker }` → **`201 { preset }`**: the row is the work. |
| `PUT /v1/model-policy/presets/{id}` | `models.manage` | The same body, replacing the preset whole. `200 { preset }`. |
| `DELETE /v1/model-policy/presets/{id}` | `models.manage` | `200 { deleted }`, `404` if there is none here. |

`maker` is one choice and `checker` one to five in preference order, each `{ model, provider?,
credentialId?, declaredVendor? }` as on a task — but each must name a provider or a credential, so
the pairing can be judged now. A preset is `{ id, name, harness, maker, checker,
createdByPrincipalId, createdAt, updatedAt }`; `harness` null is the operator's default.

**Checked when saved, with intake's rules**, so the picker never offers what intake would refuse:
`400 invalid_model_preset` (no name, a name over 40 characters, a missing role, a bare model),
`400 invalid_model_policy` (a model whose vendor cannot be told, a credential for another
provider), `404 credential_not_found`, `409 credential_revoked` / `credential_invalid`,
`422 harness_unavailable`, `409 preset_name_taken` (names are unique per organization, ignoring
case), and **`409 no_independent_checker`** when no checker is another vendor's model — with the
reason `NoIndependentProviderError` gives at intake (*no checker model is independent of the maker
(openai/gpt-5): openrouter/openai/gpt-5-mini serves openai's model, and openai is the maker's
vendor*). Whether the operator holds a Windkeel-managed key for a provider stays intake's question,
as it is for a policy row.

**Resolved once, at intake, into the run.** When a run reaches intake the layers are resolved into
`engineering_run.model_config` and every later stage reads that, never the environment or the policy
rows; a policy changed now changes runs that reach intake from now on. `GET /v1/runs/{id}` returns it
as `modelConfig`:

```jsonc
{ "version": 1,
  "maker":   { "provider": "openrouter", "vendor": "openai", "model": "openai/gpt-5-codex",
               "credentialId": "…", "credentialLabel": "team-router", "keySource": "customer",
               "source": "organization", "worker": "codex" },
  "checker": [ { "provider": "openrouter", "vendor": "anthropic", "model": "anthropic/claude-sonnet-4.5",
                 "baseUrl": "…", "credentialId": "…", "credentialLabel": "review-router",
                 "keySource": "customer", "source": "organization" } ],
  "resolvedAt": "…", "policyIds": ["…"] }
```

`vendor` is derived from the **model**, not the router: `openrouter` + `anthropic/claude-*` is
`anthropic`. Maker and checker must be different vendors (ADR-0010), checked on the snapshot before
anything is provisioned. A run that cannot be resolved (a revoked or invalid credential, a provider
the operator has no key for) or is not independent goes to `FAILED` with `stopReason:
"model_policy"` and a reason naming the credential or the pairing. So does a customer key that stops
working mid-run — revoked, refused with a 401/403 (which also marks it `invalid`), or rate-limited
or out of quota (402/429, "retry the run later"). **There is no fallback** from an organization's
key to Windkeel's, or the reverse.

## Repository knowledge

Notes the maker is given in a `## Repository knowledge` section of its first prompt, with provenance
([#388](https://github.com/jyothepro/orqon/issues/388), ADR-0032). Knowledge shapes the maker only;
the verifier never reads it. Reads need `runs.read`, writes `knowledge.manage` (Admin and Member). The
row is the work, so writes answer 201/200. A repository the organization holds no grant on — and any
note on one — is 404.

| Route | |
|---|---|
| `GET /v1/knowledge?repositoryId=&status=` | A repository's notes and its organization's (`?scope=organization` for the organization's only; neither for every note). `status` is `active`, `suggested`, `rejected` or `archived`. |
| `POST /v1/knowledge` | `{ repositoryId?, title, body, pathGlobs? }` ⇒ 201, `active`, attributed to the caller. No `repositoryId` is organization-wide. Title ≤ 200 characters, body ≤ 8000. |
| `POST /v1/knowledge/{id}` | `{ version, title?, body?, pathGlobs? }` — `version` is the one you read; anything else is `409 version_conflict`. |
| `POST /v1/knowledge/{id}/status` | `{ action: accept \| reject \| archive \| restore }`. Accepting is how a held lesson reaches the maker. |
| `DELETE /v1/knowledge/{id}` (or `POST …/delete`) | Deletes it; a learned lesson stays deleted (it is not learned again). |
| `GET /v1/knowledge/{id}/revisions` | Every version, with who made it. |
| `GET /v1/repositories/{id}/digest` | The codebase digest (`?commitSha=` for one commit's): `{ commitSha, body, sources[] }`, or `digest: null`. |
| `GET /v1/runs/{id}/knowledge` | Exactly what that run's maker was given, frozen when its session started: title, body, `provenance`, note id and version. |

**Learned lessons are risk-tiered.** After a run's repair loop ends, each repair packet becomes up to
five lessons (`sourceKind: verifier_finding`, `sourceRef.runId`). A deterministic classifier decides:
a low-risk descriptive fact is `active` at once (`risk: low`, deletable); anything that names a
command, secrets, the network, weakening tests or the verifier — or that it cannot classify — is
`suggested` (`risk: high`, with `riskReasons`) and is never injected until someone accepts it.

## Cost by key source

Every model cost event records whose key paid — `windkeel` or `customer`, with the credential's id for
`customer` — and the price comes from the model catalog for the run's own model (operator pins
`WINDKEEL_USD_PER_*` / `WINDKEEL_CHECKER_USD_PER_*` win per field). A model the catalog cannot price is
recorded with its tokens and `usd: null`: unknown, not zero ([#242](https://github.com/jyothepro/orqon/issues/242)).

`GET /v1/runs/{id}/cost`:

| Field | |
|---|---|
| `totalUsd` | The priced events' sum — a lower bound whenever `unpricedEvents` is non-zero. |
| `unpricedEvents` | Model calls with tokens and no price. |
| `byStage[]` | `{ stageType, kind, keySource, usd, tokensIn, tokensOut, events, unpricedEvents }`. `stageType` is `agent_run`, `verification_run`, `criteria` (generating acceptance criteria, before any verification exists) or `workspace`. `keySource` is null on sandbox rows and on model rows from before M9. |
| `bySource[]` | Model spend only, per key source (`windkeel`, `customer`, null for pre-M9 rows), with the same totals. A run entirely on Windkeel's keys has one entry. |
| `spendCapUsd`, `runRowCost` | The cap, and the run row's maintained sum beside the ledger's (ADR-0013 §1). |

The spend cap counts an unpriced call at a conservative rate (`WINDKEEL_UNPRICED_USD_PER_*`, by default
the catalog's highest), and a cap met on that estimate says so in the transition reason.

## Usage, budgets and billing

ADR-0037 (#394). Usage is the cost ledger added up for one calendar month (UTC); nothing else is a
source of spend. Readable by anyone in the organization (`runs.read`); changing the budget, and
reaching checkout or the portal, need `billing.manage` (Admin).

| Method | Path | Permission | What |
|---|---|---|---|
| `GET` | `/v1/usage?period=YYYY-MM` | `runs.read` | the month (default: this one): `raw` (Windkeel-key AI, own-key AI, sandbox), `verification` (its own line, never waived), `unpriced` (count and estimate — not invoiced), `billable` (AI cost, compute fee, verification fee, total, total in micro-USD), `budget` (limit, spent, remaining, exhausted), `plan`, `billingStatus`, `alerts` |
| `GET` | `/v1/budget` | `runs.read` | `monthlyLimitUsd` (null = unlimited), `alertThresholdPct`, `defaultRunCapUsd`, `includeCustomerKeySpend`, who changed it last |
| `PUT` | `/v1/budget` | `billing.manage` | the same fields; any left out keep their value. Answers the saved budget (the row is the work, so 200, not 202) |
| `GET` | `/v1/billing` | `runs.read` | provider, plan (`internal`, `byok`, `managed`), status (`active`, `past_due`, `suspended`) |
| `POST` | `/v1/billing/checkout` | `billing.manage` | `{returnUrl}` (must be on `WINDKEEL_CONSOLE_URL`) → `{url}` on the provider's checkout |
| `POST` | `/v1/billing/portal` | `billing.manage` | `{returnUrl}` → `{url}` on the provider's billing portal |
| `POST` | `/v1/billing/webhooks/{provider}` | public | the provider's signed webhook. 401 on a bad or stale signature; a replayed event id is a 200 no-op. Credit grants and plan changes ride on it (ADR-0040) |
| `GET` | `/v1/billing/balance` | `runs.read` | credits (ADR-0040; 1 credit = US$0.01): `onCredits`, `plan`, `pendingPlan`, `period` (with `daysToReset`), `planCredits` (included, used, left), `topups` (credits, left, `expiresAt`), `overage` (enabled, cap, billed, unbilled), `availableCredits`, `admits`, `alerts`, and the `catalog` of plans and packs |
| `GET` | `/v1/billing/statement?period=YYYY-MM[&format=csv]` | `runs.read` | the month's credits by run, repository and role; `format=csv` is the same as a CSV export |
| `PUT` | `/v1/billing/overage` | `billing.manage` | `{enabled, capCredits}` — on needs a cap and a plan subscription (409 `not_on_credits` otherwise). Answers the balance |
| `POST` | `/v1/billing/plan` | `billing.manage` | `{plan: "starter" \| "pro" \| "team" \| "scale"}` → `202 {plan, from, effective: "now" \| "period_end"}`; an upgrade is now, a downgrade at period end. `409 no_subscription` before a plan checkout |
| `GET` | `/v1/runs/{id}/receipt` | `runs.read` | what the run cost in credits: `compute` per role (sandbox minutes × 2), `ai` per role and model, `totals`. Also on `GET /v1/runs/{id}` as `receipt` |

`POST /v1/billing/checkout` takes `{plan}` (a subscription) or `{topup: 10 | 25 | 50}` (a one-time
pack) beside `returnUrl`; a plan or pack whose `STRIPE_PRICE_*` is unset answers `503 price_unset`.

**A refused intake is `402`.** `POST /v1/tasks` (and every other intake) answers
`402 org_budget_exhausted` when the month's budget is spent — at the limit counts — and
`402 billing_suspended` when the account is suspended, and `402 credits_exhausted` when an account
on a credit plan is out of credits with overage off or at its cap (ADR-0040), with a sentence saying
so. Nothing is written.
A run already going is not stopped by a refusal at intake; its next **maker** turn is (`org_budget`),
and a verification already under way always finishes (ADR-0037 §5).

## Self-serve signup and installing the App

ADR-0038. Off unless `WINDKEEL_SELF_SERVE_SIGNUP=invite`; every route below answers 404 until then.

| Method | Path | Auth | What |
|---|---|---|---|
| `POST` | `/v1/signup` | a signed-in **session with no organization** | `{inviteCode, organizationName, plan: "byok" \| "managed"}` → `201 {accountId, organizationId, principalId, trialCredits}` (500 credits, once, ADR-0040). One account per GitHub user; the code is single use |
| `POST` | `/v1/github-installations/state` | `repositories.manage` | `201 {url, expiresAt}`: the App's install link with a single-use, 30-minute state |
| `POST` | `/v1/github-installations` | the principal who asked for the state, still holding `repositories.manage` in its organization | `{installationId, state, code}` from the install callback → the installation linked and its repositories granted. `403 permission_revoked` if that person was removed or lost `repositories.manage` since asking (re-checked under lock in the transaction that claims the installation) |

Invite codes are minted by the operator: `windkeel-admin signup-invite [--note …] [--days N]`.

## Following a run

Two ways, one mechanism. Polling and streaming return the same events in the same order from the
same cursor, because the stream *is* the feed with framing added.

```bash
# Poll.
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://$HOST/v1/runs/$RUN/events?after=$CURSOR" | jq '.endCursor'

# Stream.
curl -N -H "Authorization: Bearer $TOKEN" \
  "https://$HOST/v1/runs/$RUN/events?after=$CURSOR&stream=sse"
```

```text
id: 185
event: transition
data: {"kind":"transition","cursor":"185","from":"VERIFYING","to":"REPAIRING",...}

id: 186
event: cost
data: {"kind":"cost","cursor":"186","usd":0.0141,"costKind":"model",...}

id: 187
event: agent
data: {"kind":"agent","cursor":"187","agentRunId":"…","role":"repairer","event":{"type":"test_finished","command":"npm test","exitCode":0,"passed":true}}

id: 187
event: cursor
data: {"cursor":"187","reason":"budget_exhausted","reconnect":true}
```

**`agent` events are the agent's own steps** (`migrations/0022_agent_event.sql`). `event` is the
worker's normalized event (`WorkerEvent` in `src/worker/adapter.ts`): `started`, `thinking`,
`command_started` / `command_finished`, `test_started` / `test_finished`, `file_changed`,
`message`, `completed`, `failed`. Each is one step, never a token delta, and every text field is
capped at 4,000 characters with a visible `… (truncated)`. They are written on the same run lock
and sequence as the other two kinds, so one cursor orders all three. A client that doesn't know a
kind should skip it.

**The run report carries each stage's result.** Every verification has `stages`, one entry per
stage the evidence package has items for (`checks`, `review`, `intent`, `security`, `browser`).
Each entry has the stage's most serious status and its items. It is `null` for a verification
sealed before stage results were recorded.

**Every stream ends with a `cursor` event, and being cut is the normal case.** A Vercel function
caps at 300s on Hobby and 800s on Pro — *including streamed responses* — while runs take ten
minutes to an hour. So a stream will be interrupted mid-run every time. Reconnect with
`after=<cursor>` and nothing is lost or repeated.

`reason` says what to do next:

| `reason` | `reconnect` | Meaning |
|---|---|---|
| `budget_exhausted` | `true` | The function hit its limit. Reconnect immediately. |
| `run_terminal` | `false` | The run is over. Stop. |
| `client_gone` | — | Never sent; the client had already left. |

Lines beginning `:` are keep-alives. They carry no event and never advance a cursor.

### A cursor the API did not issue is a `400`

Not a silent restart from zero. A client sent back to position zero would replay the whole run —
every event twice in a UI, a log that repeats itself in a CLI.

### Opening a long run at its tail

A run's feed can run to thousands of agent steps, and a reader showing it doesn't need them all
before it paints. Read it backwards:

| Query | Answers |
|---|---|
| `?last=N` | The newest `N` events (default 50, at most 200), **oldest first** like every page, with `startCursor`, `endCursor` and `hasPreviousPage`. Follow live from `endCursor` (`"0"` for a run with no events yet). |
| `?before=C&last=N` | The `N` events just before cursor `C` — pass the previous page's `startCursor` to read further back. |
| `?kind=transition` | Only those kinds (`transition`, `cost`, `agent`, comma-separated), forward or backward. The console's stage rail reads every transition of a long run this way, and none of its agent steps. Follow a narrowed page with the same `kind`: its cursors are positions in the whole feed. |

`after=` with `before=`/`last=` is a `400`, as is any of `before=`, `last=` or `kind=` with
`stream=sse` — the stream is the whole feed, forward, and nothing else. An unknown kind is
`400 invalid_kind`.

## Following an organization

`GET /v1/events` answers which of the organization's runs moved — so a list (the console's sidebar,
inbox and run lists) can re-read itself within seconds instead of on a timer (gap G5). It is
scoped like every organization route (`/v1/orgs/{orgId}/events`, `runs.read`), and another
organization's runs never appear in it.

```bash
# Where to start: no `after` answers only the head.
curl -s -H "Authorization: Bearer $TOKEN" "https://$HOST/v1/events" | jq '.endCursor'

# Poll from it, or stream.
curl -N -H "Authorization: Bearer $TOKEN" "https://$HOST/v1/events?after=$CURSOR&stream=sse"
```

```text
id: 9120
event: run.changed
data: {"kind":"run.changed","changeId":"9131","runId":"…","taskId":"…","from":"VERIFYING","state":"PR_READY","at":"…"}

id: 9131
event: cursor
data: {"cursor":"9131","reason":"budget_exhausted","reconnect":true}
```

**These are hints, not a second feed.** A change names a run, the state it moved to and when —
enough to know a list is stale. The run's history stays its own feed; the lists stay what
`/v1/runs` answers. A change is one row of the transition log, so a run that moves without a
transition (a pull request merged, a cost recorded) isn't in it.

**At least once, and the cursor lags by design.** Across runs, sequence order isn't commit order
(nothing serialises two runs' writers, unlike one run's), so a reader could see a later
transition before an earlier one commits. The cursor therefore only moves past transitions older
than 30 seconds (`SETTLE_SECONDS` in `src/factory/run-changes.ts`, which argues why that's
enough). A younger change is answered again on the next read: de-duplicate on `changeId`, which
is never a resume position — resume from the page's `endCursor` or the stream's `id` / closing
`cursor`.

The stream follows the same rules as a run's, with three differences:

- **It never ends on its own.** Every stream closes on its budget with `reason: "budget_exhausted"`.
- **With no `after`, it starts at the head** and treats the changes it first reads as already
  known: they were committed before the reader asked.
- **Far behind is one `resync`**, not a replay. A reader whose cursor is more than one window (500
  transitions of the whole log) behind gets `event: resync` with `{"cursor": …}`: re-read
  everything once, then carry on from that cursor.

Each read scans at most one window of the transition log by its unique `seq` index and joins each
row to its run and task by primary key, so a poll costs the same however large the log grows. The
stream polls every 2 seconds, and the console closes it while its tab is hidden.

## What the CLI still does locally

The factory commands are clients of this API, because a CLI anyone else runs cannot hold the
database's credentials: `windkeel submit` (was `windkeel-admin task create`), `windkeel show` (was `task
status` and `run report`), `windkeel metrics`, `windkeel reap` and `windkeel capture`. Only `windkeel-admin
doctor` and `secrets keygen` stay on the operator's machine — see ADR-0023's 2026-09-24 amendment for
why `doctor` does.

**`windkeel verify`, `seal`, `verify-package`, `replay` and `bench` do not.** They are the M0 engine
running on your own machine and keep working with no server, no token and no network — that is the
local PR gate, and it does not acquire a dependency on a control plane.

## Operational notes

- The API has **its own connection pool**, separate from the webhook's. A stream holding one of the
  webhook's two connections for the length of a run could starve a GitHub delivery on the same warm
  instance, and a delivery that fails is one GitHub retries into a wall.
- **Evidence files are never proxied.** A package can be tens of megabytes and a Vercel response
  body caps at 4.5 MB, so the API redirects to a presigned URL that expires in five minutes.
- The concurrency ceiling is **file descriptors** — 1,024 shared across executions, each stream
  costing a socket plus a database connection.
- Cost scales with *how long someone watches*, not with how much happens: Vercel bills active CPU,
  and a stream sleeping between polls barely uses any.
- **Not built from ADR-0023**: the rest of §10's operator
  commands (`metrics`, `reap`, `task`, `run capture`), which still need a direct Postgres connection
  and therefore still live in `windkeel-admin`. Named here so their absence stays visible.
