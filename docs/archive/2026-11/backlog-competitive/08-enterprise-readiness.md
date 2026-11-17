# Enterprise readiness: audit log + export, custom RBAC roles, SSO/SAML enforcement + SCIM, data residency, self-hosted/VPC, SOC2-supporting controls

> ADR and migration numbers below are placeholders: use the next free number in `docs/adr/` and `migrations/` when implementing.

> Epic, split into six sub-tasks (8A–8F). Each sub-task is one PR with its own done condition.
> Sub-tasks marked **[HUMAN]** need a human decision before an agent starts. Do those only after a
> maintainer has commented on this issue with the decision. Sub-tasks with no mark are agent-ready.

## Why

Windkeel competes with Devin AI and Factory.ai for engineering teams at larger companies. Their security
reviews have a fixed checklist: SSO/SAML, SCIM deprovisioning, RBAC, audit log export, data
residency, a VPC or self-hosted option, and SOC2. Devin and Factory both answer most of it. Windkeel's
real edge is the **independent verifier**: every candidate change is checked in a fresh sandbox
that the maker never touched (ADR-0004). ADR-0029's rule is that **nothing gets around
verification**, the human path included. Enterprise features must strengthen that story. The audit
log has to *prove* that every merged PR went through verification. No role, token, SCIM sync or
self-hosted configuration may be able to switch the verifier off or skip it.

Roadmap slot: `research/MILESTONES.md` row **M14 — Enterprise / self-hosted** ("Self-hosted
control plane, customer VPC sandboxes, private endpoints and storage, SSO/RBAC, audit logs,
retention. Ships what v1 already is, hardened. Single-tenant stays a supported shape (ADR-0001)").

## Background the implementer needs

### Stack and conventions
- TypeScript on Node 22, ESM. Root package `@windkeel/factory` (`src/`), workspaces `apps/ingress`
  (Vercel functions: webhooks + REST API), `apps/console` (Next.js UI), `packages/cli`,
  `packages/verification`.
- Tests are `node --test` over the compiled output: `npm test` runs clean, then build, then
  `node --test --test-force-exit test/*.test.js`. Tests import from `dist/…` and
  `apps/ingress/dist/…`, so **build before running a single file**:
  `npm run build && node --test test/<file>.test.js`.
- Postgres tests skip unless `TEST_DATABASE_URL` is set: `const skip = dbUrl ? false : "TEST_DATABASE_URL not set"`.
  They call `runMigrations` from `dist/factory/migrate.js` and use helpers from `test/helpers.js`
  (`TEST_POOL`, `seedFixtureRepository`, `repoRoot`). Model a new API test on
  `test/api-tenancy.test.js`. It drives `handleApiRequest` from
  `apps/ingress/dist/src/api/router.js` directly and uses a fake session verifier (bearer
  `session:<subject>:<githubUserId>:<login>`) plus a fake GitHub user lookup.
- Migrations are plain SQL files `migrations/NNNN_name.sql`, run in order and never edited after
  merge (ADR-0008). The last one is `0036_run_merge_claim.sql`, so **new ones start at `0037`**.
  `test/migrate.test.js` covers the runner.
- **Hermetic local dev (ADR-0016):** with no credentials set, everything must run against fakes:
  `FakeSandboxProvider` (`src/sandbox/fake.ts`), `FakeGitHubClient` (`src/github/fake.ts`),
  `test/jira-fake.js`, `test/github-stub.js`. A new external dependency (an IdP, a SCIM client, a
  storage region) needs a fake or stub, and default dev must not need it.
- ADR files are checked by `test/adr.test.js`. Follow the shape of the existing ADRs (Status, Date,
  Context/Decision/Consequences) when adding one.
- Reports and docs are terse (AGENTS.md).

### Tenancy as it exists (ADR-0024, migration `0021_tenancy.sql`, `src/factory/tenancy.ts`)
- The hierarchy is **account → organization → principal**. Tables: `account`, `organization`,
  `principal` (user or token principal; the `is_bootstrap` row is the `WINDKEEL_API_TOKEN` operator),
  `user_identity (principal_id, provider, subject)` with no FK into Supabase's `auth` schema,
  `access_role (id, account_id null, key, name, permissions text[])`,
  `membership` (one role per principal per org), `account_membership` (at most one account role),
  `api_token` (sha256-hashed `orq_…`), `scm_connection`, `repository_grant`, `invitation`,
  `device_authorization`. Service principals: `0024_service_principal.sql`.
- `src/factory/tenancy.ts` exports `PERMISSIONS` (`runs.read`, `runs.write`, `runs.approve`,
  `secrets.manage`, `repositories.manage`, `members.manage`, `tokens.manage`,
  `integrations.manage`, `schedules.manage`, `models.read`, `models.manage`, `runs.takeover`,
  `runs.merge`), `TOKEN_PRESETS`, `ADMIN_PERMISSIONS` (permissions a token gets only when asked by
  name), `resolveScope`, `getPrincipal`, `organizationsFor`, `hasAccountRole`, `createApiToken`,
  `findLiveToken`, `revokeToken`, `principalForSession(pool, SessionClaims)`, `listMembers`,
  `putGrant`/`GrantForbiddenError`, and scoping helpers `taskInOrganization`, `runInOrganization`,
  `grantedRepository`.
- Built-in roles: Admin (all permissions), Member (`runs.read/write/approve`, plus `runs.takeover`),
  Viewer (`runs.read`). **Custom roles are anticipated** (`access_role.account_id` non-null) but
  nothing creates them. A comment on `runs.merge` says "grantable to Member waits for per-account
  roles".
- ADR-0024 §5: Supabase Auth only authenticates people (GitHub OAuth, **SAML SSO on Pro and
  above, one connection per customer**, MFA). Authorization is Windkeel's own tables, with membership
  looked up on every request and **no RLS**. A Supabase user with no `user_identity` row gets
  `403 not_a_member`. The session verifier is `apps/ingress/src/api/session.ts`
  (`SessionVerifier`, `supabaseSessionVerifier`, JWKS-verified).
- ADR-0024 §7: org routes are `/v1/orgs/{orgId}/…`. **Account-scoped routes `/v1/account/…` are
  "named here and not built: they arrive with SSO and billing"**. This epic builds them.
- ADR-0024 §8: scoping lives in the store layer. A row in another org is a **404**, not a 403.
- ADR-0024 §9: every actor column has a nullable `principal_id` beside a text actor. GitHub
  commenters can act without being Windkeel users.
- API router: `apps/ingress/src/api/router.ts` (`handleApiRequest`, `ApiAuth`). Handlers are in
  `apps/ingress/src/api/handlers.ts` and siblings (`merge.ts`, `takeover.ts`, `schedules.ts`,
  `model-credentials.ts`). The API is documented in `docs/control-plane-api.md`.
- Console settings: `apps/console/app/(settings)/settings/nav.ts` (`SECTION` map keyed by
  `SettingsTab` from `apps/console/lib/permissions.ts`; groups `personal|organization`),
  `[section]/page.tsx`, `sections.tsx`, `actions.ts`. Which tabs show is `visibleTabs`
  (ADR-0024 §12).

### Other relevant ADRs (one or two lines each)
- **ADR-0001**: single-tenant is permanently supported. "The enterprise/self-hosted milestone ships
  what v1 already is, hardened." Configuration and credentials are keyed by repository/installation,
  never schema singletons.
- **ADR-0004**: verification runs in a fresh, independent sandbox. Never reuse the maker's.
- **ADR-0008**: Supabase Postgres + Storage, SQL-file migrations, stock Postgres must work.
- **ADR-0013**: observability is a cost ledger, the append-only `run_state_transition` log and SQL
  views. That is already half an audit trail for *runs*, but not for *admin actions*.
- **ADR-0014**: sandbox secrets use brokered keys, scoped tokens and phased egress. Repository
  secrets are sealed with `WINDKEEL_SECRET_PUBLIC_KEY`; only the stage deployment holds the private key.
- **ADR-0015**: evidence retention is tiered by outcome, with tombstones (`src/factory/evidence-retention.ts`,
  `WINDKEEL_RETENTION_SWEEP_INTERVAL_MS`).
- **ADR-0016**: hermetic local dev by default (see above).
- **ADR-0020 / 0021**: the control plane is Vercel end-to-end, and Vercel Workflow backs
  `WorkflowProvider`. A self-hosted mode has to replace or ship these, which is the hard part of 8E.
- **ADR-0022**: evidence signing is best-effort and says so.
- **ADR-0026**: BYOK model credentials are sealed per org, with a per-run model snapshot.
- **ADR-0029** (Proposed): integrated assistant. **The verifier stays the gate** for every
  candidate, including a person's. Adds `runs.takeover`, `runs.merge` and a `human_session` actor.
- Evidence storage: `src/factory/evidence-storage.ts` (`EvidenceStorage`, `S3EvidenceStorage`,
  `S3StorageConfig`, `evidenceObjectKey`). Sandbox seam: `SandboxProvider` /
  `SandboxProviderCapabilities` in `src/sandbox/provider.ts`, selected in
  `src/factory/sandbox-providers.ts`. Preflight/doctor: `src/factory/deployment-preflight.ts`,
  `src/commands/doctor.ts`, `src/commands/doctor-env.ts`.

## Scope (in) / Out of scope

**In:** 8A audit log (store, API, export, console view). 8B per-account custom roles. 8C account
SSO enforcement + SCIM 2.0 provisioning and deprovisioning. 8D data-residency region on the account,
routed to region-specific storage and DB config. 8E self-hosted/VPC deployment packaging + docs.
8F SOC2-supporting controls (session/token policy, access reviews, retention config, doctor
checks, control-mapping doc).

**Out:** obtaining a SOC2 report or choosing an auditor. Billing (item 09). Multi-region active-active
DB. Building our own SAML parser (we use Supabase SSO). Changing verifier behaviour. Customer-managed
KMS keys (they can come later as a follow-up of 8D).

## Design

### Cross-cutting invariant (all sub-tasks)
Nothing in this epic may add a permission, role, flag, env var or SCIM attribute that disables,
skips or weakens verification, or that merges an unverified candidate. 8B adds a test that asserts
`PERMISSIONS` contains nothing matching `/verif|bypass|skip/`. 8E's preflight refuses to start if a
verifier sandbox provider is missing.

### 8A — Audit log
- **Migration `0039_audit_event.sql`** (new file):
  ```sql
  create table audit_event (
    id               uuid primary key default gen_random_uuid(),
    account_id       uuid not null references account (id),
    organization_id  uuid references organization (id),
    actor_principal_id uuid references principal (id),
    actor_text       text not null,          -- login/display name, as in ADR-0024 §9
    actor_kind       text not null check (actor_kind in ('user','token','github','system','scim')),
    action           text not null,          -- e.g. 'member.role_changed', 'token.created', 'run.merged'
    target_type      text, target_id text,
    ip               inet, user_agent text, request_id text,
    detail           jsonb not null default '{}',
    prev_hash        bytea, hash bytea not null, -- hash chain for tamper evidence
    occurred_at      timestamptz not null default now()
  );
  create index audit_event_account_time_idx on audit_event (account_id, occurred_at desc, id);
  ```
  Append-only: `revoke update, delete` cannot be enforced against the privileged ingress role, so
  add a `before update or delete` trigger that raises. Retention deletes go through a dedicated
  function that the trigger allows (8F).
- Hash chain: `hash = sha256(prev_hash || canonical_json(row without hash))`, per account. Compute
  it in TS inside a transaction with `select … for update` on the account's latest row, or with
  `pg_advisory_xact_lock(hashtext(account_id))`.
- **New file `src/factory/audit-log.ts`**: `recordAuditEvent(db, AuditEventInput)`,
  `listAuditEvents(db, { accountId, organizationId?, after?, before?, action?, actorPrincipalId?, cursor, limit })`
  (cursor = `(occurred_at,id)`), `verifyAuditChain(db, accountId)`, and an `AUDIT_ACTIONS` const list.
  Record events **in the same transaction** as the change they describe.
- Call sites (instrument all of them): token create/revoke (`createApiToken`, `revokeToken`), membership
  and invitation changes, `putGrant`/`deleteGrant`, repository secret set/delete
  (`src/factory/repository-secrets.ts`), model credential store/rotate/revoke
  (`src/factory/model-credentials.ts`), model policy, integrations/schedules/webhook endpoints,
  run approve/cancel/takeover/hand-back/merge (`run-merge.ts`, `user-merge.ts`, `human-session.ts`),
  sign-in success and `not_a_member` refusals (`principalForSession`), and from 8B–8F role, SSO and
  SCIM changes. The verifier's verdict is written as `run.verified` / `run.verification_failed`, so
  an auditor can join `run.merged` to a passing verification.
- New permission `audit.read` (Admin only, in `ADMIN_PERMISSIONS`).
- API (account-scoped, new `/v1/account/…` family per ADR-0024 §7):
  - `GET /v1/account/audit-events?after=&before=&action=&actor=&org=&cursor=&limit=` returns JSON pages.
  - `GET /v1/account/audit-events/export?format=jsonl|csv&after=&before=` streams the export. Use the
    pattern in `apps/ingress/src/api/stream.ts`/`sse.ts`, or a signed URL into evidence storage if
    the export is over ~4 MB. `evidence-storage.ts` notes the 4.5 MB Vercel body cap.
  - `GET /v1/account/audit-events/verify` returns `{ ok, brokenAt? }`.
  - Org-scoped mirror: `GET /v1/orgs/{orgId}/audit-events` (filtered to that org).
- Optional streaming sink (env `WINDKEEL_AUDIT_WEBHOOK_URL` + `WINDKEEL_AUDIT_WEBHOOK_SECRET`, HMAC
  signed like `src/intake` HMAC): a sweep in `src/factory/sweeps/` forwards new rows to SIEMs, at
  least once, with a cursor stored in a new table `audit_sink_cursor` in the same migration.
- Console: new settings tab `audit` (group `organization`, or a new `account` group, see 8C) with a
  filterable table and an "Export" button. Add it to `SECTION` in `nav.ts` and to `SettingsTab`/`visibleTabs`.
- CLI: `windkeel audit export --since 2026-10-01 --format jsonl > audit.jsonl` in `packages/cli`.

### 8B — Custom roles per account
- **Migration `0040_account_roles.sql`**: no new tables (`access_role` already supports
  `account_id`). Add `description text`, `created_by_principal_id`, `updated_at`. Add the permission
  `roles.manage`, seeded onto built-in Admin. Data migration: update Admin's `permissions` to the
  full current list, including `audit.read` from 8A.
- `tenancy.ts`: `createRole`, `updateRole`, `deleteRole` (refused while memberships reference it,
  `RoleInUseError` → 409), `listRoles(accountId)` (built-ins + account's). A custom role's
  permissions must be a subset of the creator's own (same rule as tokens, ADR-0024 §6). Built-ins
  are immutable (`BuiltinRoleError` → 403).
- `runs.merge` becomes grantable to a custom "Member + merge" role, which resolves the comment in
  `PERMISSIONS`. The merge route still refuses tokens (session only).
- API: `GET/POST /v1/account/roles`, `PATCH/DELETE /v1/account/roles/{id}`. Membership PUT accepts
  any role id visible to the account. A role id from another account is a 404.
- Console: Members tab role picker lists custom roles; a new `roles` settings tab handles create/edit.
- Every change emits `role.created|updated|deleted` audit events.

### 8C — SSO enforcement + SCIM **[HUMAN: IdP strategy]**
- **Migration `0039_account_sso_scim.sql`**:
  - `account_sso (account_id pk, provider text check in ('supabase_saml'), sso_provider_id text,
    domains text[] not null, enforced boolean default false, default_organization_id uuid,
    default_role_id uuid, created_at, updated_at)`.
  - `scim_token (id, account_id, prefix, hash, created_by_principal_id, created_at, last_used_at, revoked_at)`,
    hashed exactly like `api_token`.
  - `principal` gains `scim_external_id text`, `deactivated_at timestamptz`, `email text`.
    Partial unique index on `(account_id, scim_external_id)`.
  - `scim_group_mapping (account_id, scim_group_id, display_name, organization_id, access_role_id)`.
- SSO: Supabase Auth SAML (ADR-0024 §5) does the protocol. Windkeel stores which Supabase SSO provider
  belongs to which account. `SessionClaims`/`supabaseSessionVerifier` must surface the JWT's
  `amr`/`sso_provider_id` claim. In `principalForSession`, when the user's account has
  `enforced = true` and the session did not come through that SSO provider, return
  `403 sso_required`. The bootstrap `WINDKEEL_API_TOKEN` stays break-glass and is exempt, with a doctor
  warning. With SSO JIT provisioning, a first SSO sign-in whose email domain is in `domains` creates
  the principal + `user_identity` + membership in `default_organization_id` with `default_role_id`.
  This deliberately relaxes the invitation-only rule of ADR-0024 §5, **for that account only**, and
  needs an ADR amendment.
- SCIM 2.0 (RFC 7643/7644) under `/scim/v2/` in `apps/ingress` (new file
  `apps/ingress/src/api/scim.ts`, routed from `router.ts`). Bearer is a `scim_token`, not an `orq_`
  token. Endpoints: `GET/POST /Users`, `GET/PUT/PATCH/DELETE /Users/{id}`, `GET/POST/PATCH/DELETE /Groups`,
  `ServiceProviderConfig`, `ResourceTypes`, `Schemas`. Support the filter `userName eq "…"` and
  `externalId eq "…"`, at minimum.
  - **Deactivate** (`active:false` or DELETE): set `deactivated_at`, delete memberships, **revoke
    every personal `api_token` the user owns**, and expire workspace git tokens and human sessions
    (`human-session.ts`). Org tokens/service principals survive (ADR-0024 §6). In-flight runs keep
    going, and their actor stays recorded.
  - Group membership drives `membership` through `scim_group_mapping`.
  - Every SCIM write emits an audit event with `actor_kind='scim'`.
- `principalForSession` and `findLiveToken` both refuse a principal with `deactivated_at` set.
- API: `GET/PUT /v1/account/sso`, `POST /v1/account/scim-tokens`, `DELETE /v1/account/scim-tokens/{id}`,
  `GET/PUT /v1/account/scim-groups`. New permission `account.manage` (account role only).
- Console: a new `account` group in `nav.ts` with tabs `sso` and `scim`, shown only to holders of
  the account Admin role (`hasAccountRole`).
- Security: SCIM tokens are shown once and sha256-stored. They are rate limited
  (`apps/ingress/src/connection-limit.ts` pattern). Constant shape 404s across accounts. No SCIM
  attribute can grant a permission beyond what the mapped role holds.

### 8D — Data residency **[HUMAN: regions offered + whether DB is per-region]**
- **Migration `0040_account_region.sql`**: `account.data_region text not null default 'us'`, with a
  check against the configured list.
- Config: `WINDKEEL_DATA_REGIONS` (JSON: `{ "us": { evidenceBucket, evidenceEndpoint, sandboxRegion }, "eu": {...} }`)
  is parsed in `src/factory/worker-config.ts` / `apps/ingress/src/config.ts`. Evidence writes pick
  `S3StorageConfig` by the run's account region (task → org → account). `evidenceObjectKey` is
  unchanged, but `parseEvidenceRef` already carries the bucket, so reads route naturally.
- Sandbox region is passed through `SandboxCreateOptions` if the provider supports it. Add
  `SandboxProviderCapabilities.regions?: string[]`. When the region is unsupported, **refuse to
  create** rather than fall back silently.
- Default proposal: one deployment per region (separate Postgres + Vercel project) rather than a
  multi-region DB. Then `data_region` is a guard that refuses to create an account whose region
  doesn't match `WINDKEEL_DEPLOYMENT_REGION`, plus routing for storage. Model calls go through BYOK
  (ADR-0026), and the customer picks the endpoint region. Document this.
- `GET /v1/account` exposes `data_region`. Changing it after creation is refused (409).

### 8E — Self-hosted / VPC deployment **[HUMAN: packaging target + Workflow replacement]**
- Today's deps: Vercel functions (ingress, console), Vercel Workflow (ADR-0021), Vercel Sandbox,
  Supabase Postgres/Storage/Auth. ADR-0007 (pg-boss `WorkflowProvider`) is superseded by ADR-0021,
  but it shows that a Postgres-backed provider was designed before.
- Deliverable (default proposal): **"Windkeel self-hosted"** = Docker images for ingress (Node HTTP
  server wrapping `handleApiRequest` + webhook handler, new file `apps/ingress/src/server.ts`), the
  console (`next start`) and the worker. A `deploy/self-hosted/docker-compose.yml` (new) with
  Postgres + MinIO (S3-compatible, already supported by `S3EvidenceStorage`). A Helm chart is a
  follow-up.
- Seams needed:
  - `WorkflowProvider`: a Postgres-backed implementation for self-hosted (new ADR) **or** require the
    Vercel Workflow "world" adapter on self-hosted. Human decision.
  - `SandboxProvider`: a container/Kubernetes-backed provider for customer VPC sandboxes (new file
    `src/sandbox/docker.ts`, implementing `SandboxProvider`, with honest `capabilities`). It must
    satisfy the same contract the `FakeSandboxProvider` tests exercise. **The verifier still gets a
    fresh sandbox (ADR-0004).**
  - Auth: generic OIDC `SessionVerifier` (new) beside `supabaseSessionVerifier`, with
    `user_identity.provider = 'oidc'` (ADR-0024 §5 already allows another provider row).
  - GitHub Enterprise Server: `WINDKEEL_GIT_HOST` already exists. Add `WINDKEEL_GITHUB_API_URL` to
    `src/github/rest.ts`.
- `src/factory/deployment-preflight.ts` + `doctor`: new profile `WINDKEEL_DEPLOYMENT_MODE=self-hosted`
  that checks Postgres reachability, the migration level, storage bucket write/read, sandbox provider
  create/destroy, verifier provider present, secret keypair split (ADR-0014), and no outbound call
  to Vercel/Supabase unless configured.
- Docs: new `docs/self-hosted.md`, covering topology, network egress list, env vars, upgrade
  (`migrate`) and backup.

### 8F — SOC2-supporting controls
- Session/token policy per account (new migration `0041_account_security_policy.sql`):
  `account_security_policy (account_id pk, max_token_ttl_days int null, require_token_expiry bool,
  idle_session_minutes int null, require_mfa bool, ip_allowlist cidr[] null)`. Enforce it in
  `createApiToken` (reject or clamp `expires_at`), `principalForSession` (MFA via JWT `aal2`, idle
  timeout), and the router (IP allowlist on API + console API routes, deny = 403 `ip_not_allowed`,
  audited).
- Access review: `GET /v1/account/access-review` returns CSV/JSON of every principal, role per org,
  tokens (prefix, scopes, last_used_at, expires_at) and service principals. A console button too.
- Retention: `audit_event` retention days (default 365, min 90) is configurable on the policy. The
  sweep sits next to evidence retention (ADR-0015, `src/factory/sweeps/`) and only deletes through
  the trigger-allowed function. It writes an `audit.retention_swept` event.
- Doctor checks: break-glass `WINDKEEL_API_TOKEN` still in use, tokens without expiry, SSO not
  enforced, audit sink failing, evidence signing disabled (ADR-0022).
- New doc `docs/security/soc2-controls.md` maps each control (CC6.1 access, CC6.2 provisioning,
  CC6.3 deprovisioning, CC7.2 monitoring, CC8.1 change management, which is the verifier + PR flow)
  to the code and tables that implement it.

## Implementation steps

8A
1. Add `migrations/0039_audit_event.sql` (table, index, append-only trigger, `audit_sink_cursor`).
   Run `npm run build && node --test test/migrate.test.js`.
2. Add `src/factory/audit-log.ts` with record/list/verify + `AUDIT_ACTIONS`. Write unit tests.
3. Add `audit.read` to `PERMISSIONS` + `ADMIN_PERMISSIONS` in `tenancy.ts`. In the same migration,
   add it to the Admin `access_role`.
4. Instrument the call sites listed in Design, one domain per commit, each with an assertion in its
   existing test file.
5. Add the API routes in `router.ts`/new `apps/ingress/src/api/audit.ts`, and the export streaming.
6. Add the console `audit` tab and the CLI `audit export`. Document both in `docs/control-plane-api.md`.
7. Optional sink sweep + env vars in `.env.example`.

8B
1. Migration `0038`. 2. Role CRUD in `tenancy.ts` with the subset rule. 3. Routes. 4. Console roles
tab + role picker. 5. Audit events. 6. Update the ADR-0024 amendment note (custom roles built).

8C (after the human decision)
1. Write ADR-0030 "SSO enforcement and SCIM", amending ADR-0024 §5 (JIT provisioning per account).
2. Migration `0039`. 3. Surface SSO claims in `session.ts`, enforce in `principalForSession`.
4. `deactivated_at` checks in `principalForSession`/`findLiveToken`. 5. `scim.ts` Users, then Groups.
6. Account routes + console `account` group. 7. Audit events.

8D (after decision) 1. Migration `0040`. 2. Region config parse + validation. 3. Evidence storage
routing. 4. Sandbox region capability + refusal. 5. Docs.

8E (after decision) 1. ADR for self-hosted topology + WorkflowProvider choice. 2. `apps/ingress/src/server.ts`.
3. Dockerfiles + compose. 4. OIDC verifier. 5. Docker sandbox provider. 6. Preflight profile.
7. `docs/self-hosted.md`. 8. CI job that boots compose and runs the smoke test.

8F 1. Migration `0041`. 2. Enforcement points. 3. Access review endpoint. 4. Retention sweep.
5. Doctor checks. 6. Controls doc.

## Done condition

8A
- `audit_event` exists. UPDATE/DELETE on it raises outside the retention function.
- Each action in `AUDIT_ACTIONS` is emitted by at least one code path, and a test asserts each one.
- `GET /v1/account/audit-events` pages correctly, with stable cursors and no duplicates/gaps under
  concurrent inserts. Callers without `audit.read` get a 403, and another account's events are invisible.
- The export returns valid JSONL/CSV that matches the list endpoint for the same range.
  `verify` reports `ok:true` and detects a tampered row.
- A merged run's audit trail contains `run.verified` before `run.merged`.
- `npm test` is green, with the Postgres tests run under `TEST_DATABASE_URL`.

8B: an account admin creates a role with a subset of their permissions, assigns it, and the member's
effective permissions change on the next request. Superset, built-in edit and in-use delete are
refused with the right codes. No permission name matches `/verif|bypass|skip/`.

8C: with `enforced=true`, a GitHub-OAuth session gets `403 sso_required` and an SSO session
succeeds. SCIM create/patch/deactivate works against the RFC flows. Deactivation revokes the
personal tokens (a following API call with that token is 401) and removes memberships. An Okta/Azure
AD SCIM validator run (manual) passes.

8D: an account in `eu` writes evidence only to the `eu` bucket. An unsupported sandbox region
refuses. Region change is 409.

8E: `docker compose up` brings up a working stack with no Vercel/Supabase credentials. The smoke
test creates a task, the fake (or docker) maker runs, a fresh verifier sandbox runs, and a verified
draft PR goes against `test/github-stub.js`/`FakeGitHubClient`. `windkeel doctor` passes in the
self-hosted profile.

8F: policies are enforced (token TTL clamp/refuse, IP deny, MFA required). The access review export
lists every principal. The retention sweep deletes only old rows and logs it. The doctor checks fire.

## How to verify the done condition

```bash
npm run build
# hermetic (no DB): must pass
npm test
# with Postgres (local docker postgres:16 or Supabase branch)
export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/windkeel_test
node --test test/migrate.test.js test/audit-log.test.js test/api-audit.test.js \
  test/api-tenancy.test.js test/api-roles.test.js test/api-scim.test.js \
  test/data-region.test.js test/security-policy.test.js
# console browser (needs playwright-core + chromium)
node --test test/console-audit-browser.test.js
# self-hosted smoke (8E)
docker compose -f deploy/self-hosted/docker-compose.yml up -d && node --test test/self-hosted-smoke.test.js
```
Proof is all tests passing with no skip messages for the DB tests (check that the output does not say
`TEST_DATABASE_URL not set`). Manual for 8C: configure a Supabase SAML provider with a test Okta app,
sign in, see the account; run Okta's SCIM test suite against `/scim/v2`; deactivate a user and
confirm `orq_` token → 401. Attach screenshots/log excerpts to the PR.

## Tests required

### Unit tests
- `test/audit-log.test.js` (new): hash chain computation is deterministic; `verifyAuditChain` detects
  a modified `detail`, a deleted middle row and a reordered row; cursor encoding/decoding round-trips;
  unknown action rejected; CSV escaping (commas, quotes, newlines, unicode); a large `detail` is truncated
  safely.
- `test/api-endpoints.test.js` / `test/api-routing.test.js`: new routes are registered, and `/v1/account/*`
  needs an account-role caller.
- `test/tenancy` cases in `test/api-tenancy.test.js` style: role subset rule, built-in immutability.
- `test/scim-parse.test.js` (new): SCIM filter parser (`eq`, `and`, bad input → 400 `invalidFilter`),
  PATCH op application (`add/replace/remove`, path forms Okta and Azure send), error schema shape.
- `test/session-sso.test.js` (new): SSO claim extraction from a signed JWT (reuse the key generation in
  `api-tenancy.test.js`), missing claims, `aal` levels.
- `test/data-region.test.js` (new): config parse, unknown region, storage routing choice, refusal path.
- `test/security-policy.test.js` (new): TTL clamp/refuse, CIDR matching (v4/v6, proxied
  `x-forwarded-for` handling — trust only Vercel's/configured proxy header), idle timeout math.
- `test/doctor.test.js`: new checks.
- `test/adr.test.js` passes with the new ADRs.

### Integration / e2e (real Postgres, `TEST_DATABASE_URL`, fakes for GitHub/sandbox)
- `test/api-audit.test.js` (new): drive `handleApiRequest` as in `api-tenancy.test.js`. Create a token,
  change a role, grant a repo, set a secret; list and export match; a Viewer gets 403; a second
  account sees none; 50 concurrent `recordAuditEvent` calls give an unbroken chain.
- Extend `test/e2e-github-loop.test.js` (or a new `test/e2e-audit-trail.test.js` built on
  `test/factory-stack.js` + `FakeGitHubClient`/`FakeSandboxProvider`): a full issue → verified PR →
  merge produces `run.verified` then `run.merged` with the right principal. A failed verification
  produces no `run.merged`, and merge is refused.
- `test/api-roles.test.js` (new): role CRUD, assign, effective permission change on the next request,
  cross-account 404.
- `test/api-scim.test.js` (new): full Users lifecycle, Groups → membership, deactivate revokes tokens
  and human sessions, SCIM token from another account → 401, revoked SCIM token → 401.
- `test/api-tenancy.test.js`: add `sso_required` and deactivated-principal cases.
- `test/evidence-storage.test.js`: region routing with two fake buckets.
- `test/self-hosted-smoke.test.js` (new, skips unless `WINDKEEL_SELF_HOSTED_URL` is set).

### Browser tests
- `test/console-audit-browser.test.js` (new), following `test/console-browser.js` /
  `test/console-models-browser.test.js` (playwright-core chromium against a local server wrapping
  `handleApiRequest`). Admin sees the Audit tab, filters by action, clicks Export, and a file
  downloads. A Member does not see the tab. The account SSO/SCIM tabs are visible only to the account
  admin. The roles editor creates a role.

## Risks & open questions

| # | Question | Needs human? | Proposed default |
|---|---|---|---|
| 1 | IdP strategy: rely on Supabase SAML (Pro plan, one connection/customer, per *project* shared with other products, see ADR-0024 §5) vs WorkOS/own SAML | **Yes** | Supabase SAML for hosted, generic OIDC for self-hosted. Revisit if more than ~20 SSO customers. |
| 2 | JIT provisioning relaxes ADR-0024's invitation-only rule | **Yes** | Allowed only for verified domains on an account with SSO configured, via an ADR amendment |
| 3 | Regions offered, and per-region deployment vs multi-region DB | **Yes** | `us` + `eu`, one full deployment per region |
| 4 | Self-hosted packaging (compose/Helm/Terraform) and the WorkflowProvider replacement for Vercel Workflow | **Yes** | Docker compose first. Postgres-backed WorkflowProvider via a new ADR (ADR-0007 precedent). |
| 5 | Licensing/support terms for self-hosted | **Yes** (business) | Out of scope for code |
| 6 | Audit retention minimum and whether customers can delete | **Yes** | 365 days default, 90 minimum, no customer delete |
| 7 | Is Supabase Auth SSO JWT exposing the SSO provider id reliably? | Agent spike | Verify against a Supabase branch before 8C step 3. If not, map by email domain. |
| 8 | Supabase Auth config is shared with other products on the project | Risk | Only add SSO providers, never replace them (ADR-0024 §5) |
| 9 | The hash chain needs serialization per account, which costs write throughput | Risk | Advisory lock per account. Volume is low (admin actions + run milestones). |
| 10 | SOC2 audit itself (auditor, Vanta/Drata) | **Yes** (business) | Out of scope. The controls doc feeds it. |

## Suggested labels and dependencies

- 8A audit log: `ready-for-agent`. No blockers. Do it first, because everything else emits into it.
- 8B custom roles: `ready-for-agent`. Blocked by 8A (audit events), but it can be done in parallel
  and wired in afterwards.
- 8C SSO + SCIM: `ready-for-human` (decisions 1, 2, 7), then agent. Blocked by 8A and 8B.
- 8D data residency: `ready-for-human` (decision 3). Blocked by 8A. Related to `09-billing-onboarding`
  (region chosen at signup).
- 8E self-hosted/VPC: `ready-for-human` (decision 4). Blocked by `02-environment-snapshots` (sandbox
  provider seam changes) and coordinated with `10-multi-harness` (worker images). Benefits from
  `01-live-proof`, since the live path must be proven before it is repackaged.
- 8F SOC2 controls: `ready-for-agent` for policy + access review + doctor. The controls doc is
  `ready-for-human` review. Blocked by 8A and 8C (MFA/SSO pieces).
- Epic: `enhancement`, milestone M14.
