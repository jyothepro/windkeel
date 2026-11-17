-- Subscription plans with included credits, top-ups, overage with a cap (#431, ADR-0040).
--
-- Additive. An account is on credits from `billing_account.credit_billing_since` on; until then
-- (every existing account) it is billed exactly as ADR-0037 describes, and nothing here changes it.
--
-- **The cost ledger stays the source of truth for spend** (ADR-0013, ADR-0028, ADR-0037 §1). A
-- `credit_debit` is the price, in credits, of one `cost_event` row — at most one per row (the
-- unique key is the idempotency) — and says which grants paid for it (`credit_allocation`) and how
-- much went past them (`overage_micro`). No balance is stored anywhere: what is left of a grant is
-- its amount minus its allocations.
--
-- Amounts are integers of **micro-credits** (1 credit = US$0.01 = 1,000,000 micro-credits), so a
-- sum is exact and a receipt equals the debits it is made of.
--
-- No object here is schema-qualified (ADR-0024 §11).

-- How long a workspace's sandbox ran for the time it is charged for, as the provider reported it.
-- Credits are priced per sandbox-second from this (2 credits a minute, per started second).
-- Null on model rows and on sandbox rows recorded before this migration.
alter table cost_event add column sandbox_ms bigint check (sandbox_ms is null or sandbox_ms >= 0);

alter table billing_account
  -- When the account moved onto credits. Null: pay-as-you-go (ADR-0037), the behaviour before.
  -- Cost recorded before this instant is never debited: it was billed the old way.
  add column credit_billing_since   timestamptz,
  -- The subscription's plan, set by `invoice.paid` (and at once by an upgrade).
  add column credit_plan            text check (credit_plan in ('starter', 'pro', 'team', 'scale')),
  -- A downgrade waiting for the period to end: the next period's `invoice.paid` makes it the plan.
  add column pending_credit_plan    text check (pending_credit_plan in ('starter', 'pro', 'team', 'scale')),
  add column provider_subscription_id text,
  -- The subscription's current period, from the provider. Null: the calendar month (UTC).
  add column credit_period_start    timestamptz,
  add column credit_period_end      timestamptz,
  -- Out of credits is a hard stop unless an admin turns overage on, and then only up to the cap.
  add column overage_enabled        boolean not null default false,
  -- When overage was last turned on: spend past the last credit from this instant is billed; before
  -- it (or while off) it is the bounded overrun of a step under way, recorded and never billed.
  add column overage_enabled_at     timestamptz,
  add column overage_cap_credits    numeric check (overage_cap_credits is null or overage_cap_credits >= 0),
  add constraint billing_account_overage_cap_check check (not overage_enabled or overage_cap_credits is not null);

-- Credits an account was given: a plan period, the difference on an upgrade, a top-up pack, or the
-- one-time trial. Each has an amount, a window, and the provider event or rule that produced it.
create table credit_grant (
  id               uuid primary key default gen_random_uuid(),
  account_id       uuid not null references account (id) on delete cascade,
  source           text not null check (source in ('trial', 'plan', 'upgrade', 'topup')),
  -- The plan (`plan`, `upgrade`) or the pack (`topup_10`, …) it came from.
  product          text,
  amount_micro     bigint not null check (amount_micro > 0),
  starts_at        timestamptz not null,
  expires_at       timestamptz not null,
  -- The provider event (or `trial:<account>`) it was granted for: the same event twice grants once.
  idempotency_key  text not null unique,
  provider_ref     text,
  created_at       timestamptz not null default now(),
  check (expires_at > starts_at)
);
create index credit_grant_account_idx on credit_grant (account_id, expires_at);

-- One per cost line, once the account is on credits.
create table credit_debit (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references account (id) on delete cascade,
  organization_id     uuid not null references organization (id) on delete cascade,
  cost_event_id       uuid not null unique references cost_event (id),
  engineering_run_id  uuid not null references engineering_run (id),
  repository_id       uuid not null,
  -- Who incurred it: the maker, the verifier (always metered, never waived), or criteria at intake.
  role                text not null check (role in ('maker', 'verifier', 'criteria')),
  kind                text not null check (kind in ('compute', 'ai')),
  model               text,
  key_source          text,
  -- Compute: the seconds billed (every started second).
  sandbox_seconds     bigint,
  tokens_in           bigint,
  tokens_out          bigint,
  -- A model call nobody priced: never invoiced (ADR-0037 §2), so it debits nothing.
  unpriced            boolean not null default false,
  amount_micro        bigint not null check (amount_micro >= 0),
  -- What no grant covered.
  overage_micro       bigint not null default 0 check (overage_micro >= 0 and overage_micro <= amount_micro),
  -- Whether that overage is billed: overage was on when it was debited. Off, it is the bounded
  -- overrun of a step already under way when the credits ran out, shown and never charged.
  overage_billable    boolean not null default false,
  -- The cost line's own time, which decides which grants were live for it.
  recorded_at         timestamptz not null,
  created_at          timestamptz not null default now()
);
create index credit_debit_account_idx on credit_debit (account_id, recorded_at);
create index credit_debit_organization_idx on credit_debit (organization_id, recorded_at);
create index credit_debit_run_idx on credit_debit (engineering_run_id);

-- Which grants paid for a debit: plan credits first, then top-ups (and the trial), oldest expiry first.
create table credit_allocation (
  debit_id      uuid not null references credit_debit (id) on delete cascade,
  grant_id      uuid not null references credit_grant (id) on delete cascade,
  amount_micro  bigint not null check (amount_micro > 0),
  primary key (debit_id, grant_id)
);
create index credit_allocation_grant_idx on credit_allocation (grant_id);

-- One per account, period and threshold: 50%, 80% and 100% of plan credits, and the overage cap.
create table credit_alert (
  account_id    uuid not null references account (id) on delete cascade,
  period_start  timestamptz not null,
  kind          text not null check (kind in ('plan_50', 'plan_80', 'plan_100', 'overage_cap')),
  used_micro    bigint not null,
  limit_micro   bigint not null,
  raised_at     timestamptz not null default now(),
  primary key (account_id, period_start, kind)
);
