-- Usage billing, per-organization budgets and invite-only self-serve signup (#394, ADR-0037,
-- ADR-0038).
--
-- Additive: every table is new, and the only changes to existing objects are a widened check
-- constraint (`stop_reason` gains `org_budget`) and one permission on the built-in admin role. The
-- backfill gives the default account an `internal` billing account on provider `none`, which is
-- never reported to anyone, and no organization a budget row: **no row is unlimited**, so every
-- existing deployment behaves exactly as it did.
--
-- The ledger (`cost_event`, ADR-0013) stays the only source of truth for spend. Nothing here stores
-- a second copy of what a run cost: `organization_usage_month` is a view over the ledger, and
-- `usage_report` records only what was *sent* to a billing provider, so a resend is idempotent.
--
-- **No object here is schema-qualified** (ADR-0024 §11): Orqon's tables live in whatever schema the
-- connection's `search_path` names, and the test suite gives each file its own.

-- One per account: who bills it, on which plan, and whether it may start work.
create table billing_account (
  account_id            uuid primary key references account (id) on delete cascade,
  -- `none`: never reported (the default account, or a deployment that does not bill).
  provider              text not null check (provider in ('none', 'fake', 'stripe')),
  -- The provider's own customer id (e.g. `cus_…`). Never card data: Orqon holds no payment details.
  provider_customer_id  text,
  -- ADR-0037 §2. `byok`: the customer's own model key; billed the compute fee only. `managed`:
  -- Orqon's models; billed AI cost + compute fee. `internal`: the operator's own, never billed.
  plan                  text not null default 'managed' check (plan in ('internal', 'byok', 'managed')),
  -- `suspended` refuses new runs at intake; runs already going continue to their verdict.
  status                text not null default 'active' check (status in ('active', 'past_due', 'suspended')),
  -- What a self-serve account's first monthly budget is set to (ADR-0038 §4). Informational after.
  trial_credit_usd      numeric not null default 0 check (trial_credit_usd >= 0),
  status_reason         text,
  -- The provider's `created` time of the last webhook event that set `status`. Stripe does not
  -- deliver in order: an event older than this is ignored for status (ADR-0037 §4).
  status_event_at       timestamptz,
  -- The subscription was deleted or canceled: invoice events no longer change `status`; only a
  -- subscription event at least as new, saying it is live again, does.
  subscription_ended    boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create unique index billing_account_provider_customer_idx
  on billing_account (provider, provider_customer_id) where provider_customer_id is not null;

-- One per organization, or none: no row is unlimited (the behaviour before this migration).
create table organization_budget (
  organization_id             uuid primary key references organization (id) on delete cascade,
  -- Null = no monthly limit.
  monthly_limit_usd           numeric check (monthly_limit_usd is null or monthly_limit_usd >= 0),
  alert_threshold_pct         int not null default 80 check (alert_threshold_pct between 1 and 100),
  -- Seeds `engineering_run.spend_cap_usd` at intake when the caller names no cap; never above what
  -- is left of the month's budget.
  default_run_cap_usd         numeric check (default_run_cap_usd is null or default_run_cap_usd > 0),
  -- Whether spend on the organization's own model key counts toward the budget. It is never billed.
  include_customer_key_spend  boolean not null default false,
  updated_by_principal_id     uuid references principal (id),
  updated_at                  timestamptz not null default now()
);

-- What was sent to the billing provider, one row per report. The idempotency record: a row is
-- written `pending` before the send and its key is what the provider dedupes on, so a sweep that
-- dies between the two resends the same key and the same amount, never a second charge.
create table usage_report (
  id                      uuid primary key default gen_random_uuid(),
  account_id              uuid not null references account (id),
  organization_id         uuid not null references organization (id),
  period_start            timestamptz not null,
  period_end              timestamptz not null,
  -- The increment reported, in millionths of a dollar: integers, so increments always sum to the
  -- period's billable total exactly (ADR-0037 §4).
  billable_micro_usd      bigint not null check (billable_micro_usd >= 0),
  -- The period's cumulative billable total this report brings the provider up to.
  cumulative_micro_usd    bigint not null check (cumulative_micro_usd >= 0),
  unpriced_calls          int not null default 0,
  -- High-water mark: the largest `cost_event.seq` the cumulative total covers.
  through_cost_event_seq  bigint not null,
  idempotency_key         text not null unique,
  provider                text not null,
  provider_ref            text,
  status                  text not null check (status in ('pending', 'sent', 'failed')),
  attempts                int not null default 0,
  last_error              text,
  created_at              timestamptz not null default now(),
  sent_at                 timestamptz,
  unique (organization_id, period_start, through_cost_event_seq)
);
create index usage_report_unsent_idx on usage_report (organization_id, period_start) where status <> 'sent';

-- Webhook deliveries already applied, so a replay is a no-op.
create table billing_webhook_event (
  provider     text not null,
  event_id     text not null,
  type         text not null,
  received_at  timestamptz not null default now(),
  primary key (provider, event_id)
);

-- One row per organization, period and threshold crossed: an alert is raised once per month.
create table budget_alert (
  organization_id  uuid not null references organization (id) on delete cascade,
  period_start     timestamptz not null,
  threshold_pct    int not null,
  spent_usd        numeric not null,
  limit_usd        numeric not null,
  sent_at          timestamptz not null default now(),
  primary key (organization_id, period_start, threshold_pct)
);

-- Invite-only self-serve signup (ADR-0038 §2). An operator mints a code; only its SHA-256 is kept.
create table signup_invite (
  id                        uuid primary key default gen_random_uuid(),
  code_hash                 text not null unique,
  note                      text,
  created_at                timestamptz not null default now(),
  expires_at                timestamptz not null,
  redeemed_at               timestamptz,
  redeemed_by_principal_id  uuid references principal (id),
  redeemed_account_id       uuid references account (id)
);

-- The `state` a GitHub App installation link carries back (ADR-0038 §3): single use, short-lived,
-- bound to the organization and the person who asked. Only its SHA-256 is kept.
create table github_install_state (
  state_hash       text primary key,
  organization_id  uuid not null references organization (id) on delete cascade,
  principal_id     uuid not null references principal (id) on delete cascade,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  used_at          timestamptz
);

-- Per-organization, per-month (UTC) spend straight from the ledger: no second source of truth.
create view organization_usage_month as
  select t.organization_id,
         date_trunc('month', c.recorded_at at time zone 'UTC') at time zone 'UTC' as period_start,
         c.kind,
         c.stage_type,
         c.key_source,
         sum(c.usd) as usd,
         count(*) filter (where c.usd is null) as unpriced_calls,
         count(*) as events
    from cost_event c
    join engineering_run r on r.id = c.engineering_run_id
    join engineering_task t on t.id = r.task_id
   group by 1, 2, 3, 4, 5;

-- ADR-0037 §5: a run stopped before a new maker turn because its organization's budget is spent.
alter table engineering_run drop constraint if exists engineering_run_stop_reason_check;
alter table engineering_run add constraint engineering_run_stop_reason_check
  check (stop_reason in (
    'spend_cap', 'wall_clock_cap', 'stuck', 'repair_cap', 'approval_expired', 'error', 'model_policy',
    'org_budget'
  ));

-- Changing an organization's budget spends its money: admin only.
update access_role set permissions = permissions || array['billing.manage'], updated_at = now()
 where key = 'admin' and account_id is null and not ('billing.manage' = any (permissions));

-- Backfill -------------------------------------------------------------------

insert into billing_account (account_id, provider, plan)
  select id, 'none', 'internal' from account where is_default
on conflict (account_id) do nothing;
