# Usage billing, per-org budgets, and self-serve onboarding

> ADR and migration numbers below are placeholders: use the next free number in `docs/adr/` and `migrations/` when implementing.

## Why

Devin and Factory.ai sell self-serve: sign up, connect GitHub, see a PR within minutes, pay by usage. Windkeel today is operator-run (ADR-0001 single-tenant shape; tenancy exists since ADR-0024 but nobody can sign up themselves, and nothing turns spend into an invoice). To compete, an organization must be able to: sign up → install the GitHub App → run a first task → see metered usage → be held to a budget → be billed.

Windkeel's edge is the independent verifier (ADR-0004, ADR-0029: "the verifier stays the gate", no path around verification). Billing must reinforce that, not erode it:
- Verification cost is **metered and shown**, never discounted away or skipped to save money. A budget that runs out stops the *next stage of a run* (ADR-0011 rail behaviour) — it never lets a candidate reach `PR_READY` unverified.
- Budget exhaustion must not create a path where a maker's output gets merged without a verdict.

## Background the implementer needs

### Cost ledger (ADR-0013, ADR-0026 §9, ADR-0028)
- `src/factory/cost-ledger.ts`: `recordCost(pool, CostEventInput)` is the **only writer** of `cost_event` and of the denormalized `engineering_run.cost`; both in one transaction, run row locked `for update` first (ordering is load-bearing for the feed cursor, migration 0017). `assertChargeable` refuses negative/non-finite amounts. `usd: null` = *unpriced* (not zero; totals with unpriced rows are lower bounds). `keySource` (`KeySource` from `src/factory/model-policy.ts`) = `windkeel` vs `customer` (BYOK); `credentialId` only when customer. `stage_type`: `agent_run | verification_run | workspace | criteria`; `kind`: `model | sandbox`.
- `sumCostEvents(pool, runId)` – invariant test: `engineering_run.cost == sum(cost_event.usd)`.
- `src/factory/rails.ts` (`runRails`, `checkCaps`, `spend_cap` stop reason) and `src/factory/rails-gate.ts` (`unpricedSpendEstimate`, conservative price for unpriced calls): the per-run spend cap. `spend_cap_usd` is on `engineering_run`; a cap is required by default.
- Metrics: SQL views (migrations 0002, 0004) + `src/factory/metrics.ts` (`collectMetrics`) behind `windkeel metrics`.
- ADR-0028: every model call is recorded at a boundary Windkeel owns — metering must read from the ledger, never from agent self-reports.

### Tenancy (ADR-0024, migration `0021_tenancy.sql`)
- `account` (the customer; comment literally says "It owns SCM connections, and later SSO, billing and audit"), `organization` (owns tasks, runs, secrets), `principal`, `user_identity` (Supabase Auth only signs people in), `membership (organization_id, principal_id, role)`. Default account/org flags (`is_default`) used by single-tenant + local paths.
- Runs reach an org via `engineering_task.organization_id` (intake: `src/intake/create-task.ts` → `createTaskFromIntake`, which takes `organizationId`, and refuses with `RepositoryNotGrantedError` without a repo grant).
- GitHub App: `src/github/app.ts`, `src/github/app-deliveries.ts`; ingress interprets `payload.installation.id` in `apps/ingress/src/interpret.ts`; `repository.github_installation_id` (migration 0005). Doc: `docs/github-app.md`.

### Console (`apps/console`, Next.js)
- Settings sections: `apps/console/app/(settings)/settings/nav.ts` (`SECTION` record keyed by `SettingsTab` from `apps/console/lib/permissions.ts`; `visibleTabs` decides visibility per role), pages under `[section]`, server actions in `actions.ts`, sections like `model-sections.tsx`.
- Auth: `apps/console/app/(auth)/login`, `not-a-member`, `apps/console/app/auth/callback`; `apps/console/lib/auth.ts`, `session.ts`. Cost display helpers: `apps/console/lib/cost.ts` (+ `cost.test.ts`). Metrics page: `apps/console/app/(console)/metrics`.
- Control-plane API: `apps/ingress/src/api/router.ts`, `handlers.ts`; doc `docs/control-plane-api.md` (ADR-0023: reads direct, writes are intents).

### Conventions
- ADR-0016 hermetic local dev: everything runs with fakes and no network by default. Every external system sits behind a port with a fake (`src/sandbox/fake.ts` FakeSandboxProvider, `src/github/fake.ts` FakeGitHubClient, `test/jira-fake.js`). Billing provider must follow this: a `BillingProvider` port + `FakeBillingProvider`; Stripe adapter only behind an env flag.
- Migrations: forward-only numbered SQL in `migrations/` (ADR-0008); latest is `0036_run_merge_claim.sql`, so next is `0037`. **Never schema-qualify** (tables live in `orqon` schema via `search_path`; tests use per-test schemas).
- Tests: `node --test` on `test/*.test.js` importing from `dist/` (`npm test` builds first). Postgres tests skip unless `TEST_DATABASE_URL` set; pattern in `test/cost-ledger.test.js` (`withRun`: create schema, `runMigrations`, `seedFixtureRepository`, `insertEngineeringTask`, `insertEngineeringRun`). Loop e2e: `test/e2e-github-loop.test.js`, `test/e2e-m9-byok.test.js`, helpers `test/factory-stack.js`, `test/helpers.js`. Browser: `test/console-browser.js`, `test/console-models-browser.test.js`. ADR conformance: `test/adr.test.js`. Console unit tests: `apps/console/lib/*.test.ts`.
- `docs/agents/issue-tracker.md` and `triage-labels.md` for labels.

## Scope

In:
1. Usage metering: per-org, per-period rollup derived from `cost_event` (no second source of truth).
2. Per-org budgets/limits: monthly USD budget, soft-alert threshold, hard limit enforced at intake and at the existing rail checkpoints; default per-run spend cap from org settings.
3. Billing seam: `BillingProvider` port, fake, Stripe adapter (usage records / meter events, customer, checkout + portal links, webhook).
4. Self-serve onboarding: signup → create account+org → install GitHub App (linked to org) → first-run wizard (pick repo, pick sample issue or paste task, watch run to verdict).
5. Docs site: a static docs section (getting started, billing, budgets, verification explained).

Out: SSO/SAML, enterprise invoicing/contracts (item 08), pricing strategy numbers (human decision), tax handling beyond what Stripe Tax does, refunds/credits UI, multi-currency, self-hosted billing (M14), marketing site.

## Design

### Data model — `migrations/0037_billing.sql` (new file)
```sql
create table billing_account (
  account_id          uuid primary key references account (id) on delete cascade,
  provider            text not null check (provider in ('none','fake','stripe')),
  provider_customer_id text,           -- e.g. cus_...; never card data
  plan                text not null default 'trial',  -- 'trial' | 'usage' | 'internal'
  status              text not null default 'active' check (status in ('active','past_due','suspended')),
  trial_credit_usd    numeric not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table organization_budget (
  organization_id     uuid primary key references organization (id) on delete cascade,
  monthly_limit_usd   numeric null check (monthly_limit_usd is null or monthly_limit_usd >= 0), -- null = unlimited
  alert_threshold_pct int not null default 80 check (alert_threshold_pct between 1 and 100),
  default_run_cap_usd numeric null,    -- seeds engineering_run.spend_cap_usd at intake
  include_customer_key_spend boolean not null default false, -- BYOK spend counts toward budget?
  updated_by principal_id uuid references principal (id),
  updated_at timestamptz not null default now()
);
create table usage_report (            -- what was pushed to the billing provider (idempotency)
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references account (id),
  organization_id uuid not null references organization (id),
  period_start timestamptz not null, period_end timestamptz not null,
  billable_usd numeric not null, unpriced_calls int not null,
  through_cost_event_seq bigint not null,   -- high-water mark
  provider_ref text, status text not null check (status in ('pending','sent','failed')),
  created_at timestamptz not null default now(),
  unique (organization_id, period_start, through_cost_event_seq)
);
create table billing_webhook_event (provider text, event_id text, received_at timestamptz default now(), primary key (provider, event_id));
create table budget_alert (organization_id uuid references organization(id), period_start timestamptz, threshold_pct int, sent_at timestamptz default now(), primary key (organization_id, period_start, threshold_pct));
-- view: per-org per-month usage from the ledger
create view organization_usage_month as
  select t.organization_id, date_trunc('month', c.recorded_at) as period_start,
         c.kind, c.stage_type, c.key_source,
         sum(c.usd) as usd, count(*) filter (where c.usd is null) as unpriced
  from cost_event c join engineering_run r on r.id = c.engineering_run_id
  join engineering_task t on t.id = r.task_id group by 1,2,3,4,5;
```
Verify actual column names (`engineering_run.task_id`, `engineering_task.organization_id`) against migrations before writing; adjust. Backfill: one `billing_account(provider='none', plan='internal')` for the default account; no budget row = unlimited (preserves current behaviour).

### Billable amount rule
`billable = sum(usd where key_source is distinct from 'customer')` (Windkeel-paid model + all sandbox) + optional platform fee per verified run (config, default 0). Customer-key model spend is shown but not billed (ADR-0026). Unpriced calls count at `rails-gate.ts` conservative estimate **for budget enforcement**, but are **not invoiced** (reported as "N unpriced calls" line). Verification cost is a separate visible line, never waived.

### Modules (new files)
- `src/billing/usage.ts`: `getOrganizationUsage(pool, orgId, period)` → `{ billableUsd, customerKeyUsd, verificationUsd, sandboxUsd, unpricedCalls, estimatedUnpricedUsd }`.
- `src/billing/budget.ts`: `getBudget`, `setBudget`, `checkOrganizationBudget(pool, orgId, now) → { ok: true } | { ok: false, reason: 'org_budget_exhausted', spentUsd, limitUsd }`, `effectiveRunCap(orgBudget, remaining)` = min(default_run_cap, remaining budget).
- `src/billing/provider.ts`: `interface BillingProvider { ensureCustomer(account): Promise<{customerId}>; reportUsage(input: {customerId, organizationId, periodStart, amountUsd, idempotencyKey}): Promise<{ref}>; checkoutUrl(account, returnUrl); portalUrl(account, returnUrl); parseWebhook(rawBody, signatureHeader): BillingEvent }`.
- `src/billing/fake.ts`: `FakeBillingProvider` (in-memory, records calls, can simulate failures/`past_due`).
- `src/billing/stripe.ts`: adapter using `fetch` against Stripe REST (or `stripe` npm, pinned); only constructed when `WINDKEEL_BILLING_PROVIDER=stripe`.
- `src/billing/report.ts`: `reportPendingUsage(pool, provider, now)` — idempotent sweep using `usage_report` high-water mark; run as a schedule/cron like existing sweeps (`docs/sweeps.md`).
- `src/billing/onboarding.ts`: `createSelfServeAccount(pool, {principal, orgName})`, `linkInstallation(pool, {installationId, organizationId, state})`.

### Enforcement points (ADR-0029: never bypass verification)
- Intake: `createTaskFromIntake` (`src/intake/create-task.ts`) calls `checkOrganizationBudget`; on exhaustion refuse with typed `OrganizationBudgetExhaustedError` (mirroring `RepositoryNotGrantedError`), and set `spendCapUsd = effectiveRunCap(...)` on the new run.
- Mid-run: **do not** add a new stop path that skips verification. Rely on the per-run cap (already sized from remaining budget at intake). Optional: at the rail checkpoint in `runRails` before spawning a new *AgentRun* (repair attempt), also check org budget → stop with new stop reason `org_budget` (add to `StopReason` union in `src/factory/rails.ts` + migration check constraint if `stop_reason` is constrained — check `0015_approval_expired_stop_reason.sql` for the pattern). A pending VerificationRun for an already-produced candidate is **allowed to finish** (verifier cost is the price of honesty); document this.
- `billing_account.status='suspended'` → intake refused; running runs continue to verdict.

### API (ingress, ADR-0023)
- `GET /v1/organizations/:org/usage?period=YYYY-MM` (member)
- `GET|PUT /v1/organizations/:org/budget` (admin; PUT is an intent, audit `updated_by`)
- `POST /v1/billing/checkout`, `POST /v1/billing/portal` (account admin) → URL
- `POST /webhooks/billing/:provider` — signature-verified, idempotent via `billing_webhook_event`; updates `billing_account.status`.
- `POST /v1/signup` is not needed if console server actions do it; prefer console server action + `src/billing/onboarding.ts`.
Add to `docs/control-plane-api.md`.

### Console UI
- New settings tab `billing` (org group) in `nav.ts` + `permissions.ts` (`visibleTabs`: admins only): usage this month (bar by kind/stage, verification line explicit), budget form, plan/status, "Manage billing" (portal link).
- Run page: when stopped by `org_budget`/intake refusal, show reason via `apps/console/lib/refusals.ts`.
- Onboarding: new route group `apps/console/app/(onboarding)/welcome/` steps: (1) name org (2) install GitHub App (link `https://github.com/apps/<slug>/installations/new?state=<signed org nonce>`; callback route `apps/console/app/api/github/installation-callback/route.ts` new) (3) pick repo → grant (4) first task: suggested "good first issue" list or paste text (5) live run view → verdict, with explainer of verification evidence. Users with no membership currently land at `not-a-member`; when `WINDKEEL_SELF_SERVE_SIGNUP=1`, redirect to `/welcome` instead.

### Config / env
`WINDKEEL_BILLING_PROVIDER=none|fake|stripe` (default `none` locally — hermetic), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_METER_EVENT_NAME`, `WINDKEEL_SELF_SERVE_SIGNUP` (default off), `WINDKEEL_TRIAL_CREDIT_USD` (default 20), `WINDKEEL_GITHUB_APP_SLUG`. Add to deploy env contract (`test/deployable-env-contract.test.js`) and `doctor` (`test/doctor.test.js`).

### Security
- Never store card data; only provider customer ids. Webhook HMAC verified on raw body, constant-time compare, replay window, idempotent.
- GitHub install `state` = signed (HMAC) org id + nonce + expiry; reject unsigned/expired → prevents attaching someone else's installation to your org. Verify installation via App JWT that the installing user has access.
- Budget PUT admin-only; usage readable by members only of that org (tenancy tests).
- Signup abuse: trial credit small, one trial per GitHub user id (`principal.github_user_id` unique), rate-limit signup.
- Metering reads only the ledger (ADR-0028) — agent cannot lower its bill (`assertChargeable` already guards).

## Implementation steps

Split into sub-tasks (separate PRs):

### 09a — Metering + budgets (no provider)
1. Write `migrations/0037_billing.sql` (tables + view + backfill). Run `test/migrate.test.js`.
2. `src/billing/usage.ts` + tests.
3. `src/billing/budget.ts` + tests.
4. Hook into `createTaskFromIntake`: budget check + run cap. Add `OrganizationBudgetExhaustedError`; map to HTTP 402/409 in ingress handlers and to a refusal in console + intake notifiers (Slack/Linear/Jira comment reasons — see `test/notifier-relayed-reason.test.js`).
5. Optional `org_budget` stop reason at the repair-spawn checkpoint; verification never skipped.
6. API endpoints usage/budget + `docs/control-plane-api.md`.
7. Extend `windkeel metrics` / admin CLI (`src/admin-cli.ts`) with `windkeel usage --org <id> --period`.
**Done:** tests below pass; with no budget row behaviour is unchanged (all existing tests green).

### 09b — Billing seam
1. `provider.ts`, `fake.ts`, `stripe.ts`, factory by env.
2. `report.ts` sweep + schedule wiring; idempotency keys `org:period:seq`.
3. Webhook endpoint + status transitions; suspended → intake refusal.
4. Conformance test shared by fake and stripe (pattern: `test/github-conformance.js`), stripe variant skipped unless `STRIPE_TEST_SECRET_KEY`.
**Done:** fake e2e reports usage exactly once per high-water mark; webhook replay is no-op.

### 09c — Console billing settings
1. `billing` tab in `nav.ts`/`permissions.ts`; section component; server actions for budget.
2. Usage chart via `apps/console/lib/cost.ts` helpers; verification line separate.
**Done:** admin sees/edit budget; member doesn't see tab; browser test green.

### 09d — Self-serve onboarding
1. `src/billing/onboarding.ts`: create account+org+membership(owner)+billing_account(trial) atomically.
2. Signed install state; installation callback route; link `repository.github_installation_id` + grant repos to org (reuse existing repository resolution, ADR-0018 / `src/factory/repository-entity.ts`).
3. Handle `installation` / `installation_repositories` webhooks for an installation linked to a non-default org (currently first-seen installs go to default account — keep that when self-serve off).
4. `/welcome` wizard pages; first-task step calls existing intake path (no special path; goes through verifier).
**Done:** fresh user → welcome → fake install → first run reaches a verdict in e2e.

### 09e — Docs site
1. New `apps/docs` (or `docs/site/` built with a static generator — default: Next.js static pages inside console under `/docs` to avoid a new deploy; human decision). Pages: Getting started, Installing the GitHub App, How verification works (ADR-0004/0029 summary), Budgets & billing, BYOK, CLI.
2. Link check test (new `test/docs-site.test.js`: every internal link resolves).
**Done:** pages build; link test green; wizard links to docs.

## Done condition
- `migrations/0037_billing.sql` exists, applies on a fresh schema and on top of 0036 with backfill; existing tests unchanged & green.
- `getOrganizationUsage` equals a hand-computed sum of `cost_event` for the org/month; BYOK spend excluded from billable; unpriced counted separately.
- Intake refuses new tasks for an org over its monthly limit with a typed, user-visible reason; runs get `spend_cap_usd ≤ remaining budget`.
- No code path moves a run to `PR_READY`/merge without a verification verdict when budget is exhausted (asserted by test).
- `BillingProvider` with fake + Stripe adapter; usage reported idempotently; webhook signed & idempotent; `WINDKEEL_BILLING_PROVIDER` default `none` keeps local dev hermetic (no network).
- Console: billing tab (admin-only), budget editable, usage shown with verification line; onboarding wizard reachable when `WINDKEEL_SELF_SERVE_SIGNUP=1`.
- Fresh-signup e2e (fakes) reaches a verdict on the first task.
- Docs pages exist and link-check passes. `docs/control-plane-api.md`, `docs/github-app.md`, `docs/running-the-factory.md` updated. A new ADR (`docs/adr/0030-usage-billing-and-org-budgets.md`, new file) records the billable-amount rule and enforcement points; `test/adr.test.js` passes.

## How to verify the done condition
```bash
npm ci
npm test                                   # builds, runs all node --test; must be green
TEST_DATABASE_URL=postgres://... npm test  # Postgres-backed tests run instead of skipping
node --test test/billing-usage.test.js test/billing-budget.test.js test/billing-provider.test.js \
  test/billing-webhook.test.js test/e2e-billing-onboarding.test.js   # after npm run build
(cd apps/console && npm test)              # console lib unit tests (check package.json script)
node --test test/console-billing-browser.test.js   # browser test, pattern of console-models-browser
```
Proof: zero failures; skip count for Postgres tests is 0 when `TEST_DATABASE_URL` set. Manual/live (human, optional): with Stripe test keys set, `WINDKEEL_BILLING_PROVIDER=stripe`, run one task; Stripe dashboard shows a meter event equal to `windkeel usage` output; `stripe trigger invoice.payment_failed` → account `past_due`.

## Tests required

Unit / Postgres (new files):
- `test/billing-usage.test.js`: empty org → 0; mix of windkeel/customer key → only windkeel billed; sandbox counted; verification line separate; unpriced rows counted & estimated, not billed; month boundary (event at 23:59:59 UTC last day); other org's events excluded; default org backfilled.
- `test/billing-budget.test.js`: no row → unlimited; under/at/over limit (at = exhausted); limit 0; alert threshold crossing writes one `budget_alert` per period (idempotent); `effectiveRunCap` = min(default cap, remaining), never negative; `include_customer_key_spend` toggle; unpriced estimate counts toward enforcement.
- `test/intake-budget.test.js`: `createTaskFromIntake` refuses with `OrganizationBudgetExhaustedError`, no task/run rows written (transaction rolled back); run cap set from budget; suspended account refused.
- `test/rails-gate.test.js` (extend): `org_budget` stops before new repair AgentRun; pending VerificationRun still completes; never transitions to PR_READY without verdict.
- `test/billing-provider.test.js` + `test/billing-conformance.js` (new): fake & stripe (skipped w/o key) same behaviour: ensureCustomer idempotent, reportUsage idempotency key dedup, failure → `usage_report.status='failed'` and retried next sweep, high-water mark doesn't double count.
- `test/billing-webhook.test.js`: bad signature 401; replay no-op; stale timestamp rejected; `past_due`/`active` transitions.
- `test/onboarding.test.js`: account+org+owner membership atomic; duplicate GitHub user → one trial; forged/expired install state rejected; installation for another org rejected.
- Extend `test/api-tenancy.test.js`: member of org A cannot read org B usage; non-admin cannot PUT budget.
- Extend `test/migrate.test.js`, `test/deployable-env-contract.test.js`, `test/doctor.test.js` (billing provider config check), `test/adr.test.js` (new ADR).
- Console: `apps/console/lib/billing.test.ts` (new) formatting, `permissions.test.ts` for tab visibility, `redirects.test.ts` for not-a-member → welcome when flag on.

Integration / e2e:
- `test/e2e-billing-onboarding.test.js` (new, pattern `test/e2e-github-loop.test.js` + `test/factory-stack.js`, FakeGitHubClient, FakeSandboxProvider, FakeBillingProvider, real Postgres): signup → link fake installation → grant repo → issue intake → run to verdict → cost_event rows → `reportPendingUsage` sends exactly the billable sum → second sweep sends nothing → set limit below spend → next intake refused.
- Budget-exhaustion-mid-run e2e (pattern `test/e2e-repair-loop.test.js`): failing verdict, budget runs out, run stops with `org_budget`, no PR opened.

Browser:
- `test/console-billing-browser.test.js` (pattern `test/console-models-browser.test.js` using `test/console-browser.js`): admin edits budget and sees saved; member has no tab; wizard steps render and advance with fakes.

## Risks & open questions
- **Pricing model** (markup on raw cost vs per-verified-PR fee vs seats) — human. Default: pass-through cost × configurable multiplier (`WINDKEEL_BILLING_MARKUP`, default 1.0) + per-verified-run fee 0.
- **BYOK spend in budget** — default: excluded from bill, opt-in to budget (`include_customer_key_spend=false`).
- **Mid-run budget exhaustion** — default: let in-flight verification finish (may overshoot by one verification); never skip it. Needs human sign-off in the ADR.
- **Unpriced calls** — enforced at conservative estimate, not invoiced. Human confirm.
- ADR-0001 single-tenant: self-serve multi-tenant is a product-shape change; needs a new ADR (0030) accepted by a human before 09d ships. Default: flag-gated off.
- Docs site hosting choice — default: static pages under console `/docs`.
- Stripe SDK vs raw fetch — default raw `fetch` to keep CLI/package weight down (`test/published-cli-weight.test.js`).
- Live proof needs real Stripe test account + GitHub App — human.

## Suggested labels and dependencies
- 09a, 09b, 09c: `ready-for-agent`. 09d: `ready-for-human` until ADR-0030 accepted (then agent). 09e: `ready-for-agent`.
- Blocked-by: 01-live-proof (real costs must be proven live before billing on them; 09b live Stripe part only). 08-enterprise-readiness relates (audit log for budget changes, RBAC) — not blocking; reuse its audit table if landed first. 10-multi-harness: ledger already harness-agnostic; no block.
