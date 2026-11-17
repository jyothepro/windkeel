# ADR-0037: Usage is billed from the cost ledger on two plans, budgets stop maker work and never verification

- Status: Accepted; amended by ADR-0040
- Date: 2026-10-21

## Context

Windkeel records every unit of spend in an append-only ledger (`cost_event`, ADR-0013), written only by `recordCost` at boundaries Windkeel owns (ADR-0028), with whose key paid for each model call (`key_source`, ADR-0026 §9).

## Decision

- §1 — The ledger is the only source of truth.
- §2 — The billable amount.
- §3 — Plans and accounts.
- §4 — The billing seam.
- §5 — Budgets, and where they are enforced.
- §6 — Configuration.

## Consequences

- Usage, budgets and billing exist without changing any deployment that does not opt in: no budget row, no billing account, the fake provider, no network.
- **Billing never affects a verdict**: nothing in the verification path calls the billing port or reads the budget; a provider outage delays an invoice, never a run.
- A new permission, `billing.manage` (Admin), guards the budget write, checkout and the portal.
- Concurrent intakes can all be admitted just under the limit; the maker-checkpoint rail stops each run at its next checkpoint, so the month can overshoot by up to one maker turn plus one verification per run in flight (§5).

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-10-21
- Resolves: [#394 — Usage billing, per-org budgets, and self-serve onboarding](https://github.com/jyothepro/orqon/issues/394)
  (with the maintainer's decisions of 2026-10-21 in its comments)
- Builds on: [ADR-0013](0013-v1-observability-cost-ledger-transition-log-sql-views.md) (the ledger),
  [ADR-0028](0028-every-model-call-is-recorded-at-a-boundary-windkeel-owns.md) (every model call recorded where Windkeel owns it),
  [ADR-0026](0026-byok-org-sealed-model-credentials-and-a-per-run-model-snapshot.md) §9 (`key_source`),
  [ADR-0016](0016-local-development-hermetic-by-default.md) (a port and a fake for every outside system)
- Amends: [ADR-0011](0011-repair-loop-policy-and-run-safety-rails.md) (one stop reason, `org_budget`)
- Leaves unchanged: [ADR-0004](0004-verification-runs-in-a-fresh-independent-sandbox.md) and
  [ADR-0029](0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md) — the verifier stays the gate
- Migration: `migrations/0049_billing.sql`
- Amended by: [ADR-0040](0040-subscription-plans-with-included-credits-then-metering.md) (credit
  plans: what an account on a plan is billed, and the credit gate beside the budget)

### Context

Windkeel records every unit of spend in an append-only ledger (`cost_event`, ADR-0013), written only by
`recordCost` at boundaries Windkeel owns (ADR-0028), with whose key paid for each model call
(`key_source`, ADR-0026 §9). Nothing turned that into an invoice, and nothing stopped an organization
from spending without limit: the only bound was ADR-0011's per-run cap.

To sell self-serve, an organization must see metered usage, be held to a budget, and be billed. The
risk is particular to Windkeel: its product is the independent verifier (ADR-0004, ADR-0029), so
billing must never become a reason a candidate goes unverified, or a path by which unverified work is
merged.

The maintainer decided (2026-10-21): **two plans** — BYOK pays a compute fee only, Managed pays AI
cost plus the compute fee; meter both from the ledger; compute-fee rates are configuration; when the
budget runs out mid-run, **finish the in-flight verification**, then block new runs; build behind a
fake provider until a Stripe account exists.

### Decision

#### 1. The ledger is the only source of truth

Usage is computed from `cost_event` joined to the run's task's organization, per calendar month in
UTC (`src/billing/usage.ts`, and the `organization_usage_month` view). There is no second store of
spend: `usage_report` records only what was *sent* to a provider, for idempotency. An agent cannot
lower its organization's bill, because there is no figure for it to edit (ADR-0028, and
`assertChargeable` refuses negative amounts).

#### 2. The billable amount

| Line | Source | Billed? |
|---|---|---|
| AI cost, Windkeel's key | `kind = 'model'`, `key_source` not `customer` | × `WINDKEEL_BILLING_AI_MULTIPLIER` |
| AI cost, the organization's key (BYOK) | `key_source = 'customer'` | **never** — shown only |
| Compute (maker and verifier sandboxes) | `kind = 'sandbox'` | × `WINDKEEL_BILLING_COMPUTE_MULTIPLIER` |
| Verification fee | verification runs that reached a verdict | `WINDKEEL_BILLING_VERIFICATION_FEE_USD` each |
| Unpriced calls (`usd` null, #242) | counted | **not invoiced**; counted toward the budget at the rail's conservative estimate |

So the **BYOK plan** pays the compute fee (sandbox time, maker and verifier, plus the per-verification
fee), and the **Managed plan** pays that plus Windkeel-supplied AI. One rule produces both: spend on the
customer's own key is never billed, spend on Windkeel's is. A BYOK organization that leaves a role on
Windkeel's key (no credential for it) is billed for that role's AI cost, which the usage view shows as
its own line — otherwise BYOK would be free AI.

**Verification is a visible line and is never waived**: its model and sandbox spend are reported
separately (`verification`) as well as inside the totals. Verification cost is the price of honesty.

The multipliers default to 1 and the fee to 0 (pass-through). Pricing numbers are a business
decision; these are the knobs, documented in `.env.example`.

#### 3. Plans and accounts

`billing_account` (one per account): `provider` (`none`, `fake`, `stripe`), the provider's customer id
(never card data), `plan` (`internal`, `byok`, `managed`) and `status` (`active`, `past_due`,
`suspended`). The default account is backfilled `none`/`internal`: never reported, never refused for
billing. An account with no row is the same.

#### 4. The billing seam

`BillingProvider` (`src/billing/provider.ts`): `ensureCustomer`, `reportUsage`, `checkoutUrl`,
`portalUrl`, `parseWebhook`. `FakeBillingProvider` is the default (`WINDKEEL_BILLING_PROVIDER` unset or
`fake`); `StripeBillingProvider` (raw `fetch`, no SDK) only when `WINDKEEL_BILLING_PROVIDER=stripe`,
which requires `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_METER_EVENT_NAME` — missing
ones fail `windkeel-admin doctor` and `/api/preflight` by name, and the API then builds no provider
rather than silently using the fake.

- **Reporting** (`src/billing/report.ts`, on the hourly sweep): increments, in integer micro-USD, of
  the month's billable total minus what was already reported, keyed `org:YYYY-MM:seq` on the
  ledger's high-water mark. A row is written `pending` before the send; a failed send is resent with
  the same key and amount before anything new. Events younger than one minute wait for the next
  sweep (a `seq` is drawn at insert and visible at commit). Stripe meter events dedupe on that key.
- **Webhooks** (`POST /v1/billing/webhooks/{provider}`): the Stripe-style signature over the raw
  body, constant-time, five-minute tolerance; idempotent on the event id (`billing_webhook_event`);
  the only effect is `billing_account.status`. Stripe does not deliver in order, so status follows
  the event's `created` time, not arrival: an event older than the last one applied
  (`status_event_at`) is ignored, and once the subscription is deleted or canceled
  (`subscription_ended`) invoice events change nothing — only a subscription event at least as new,
  saying it is live again, re-activates it. The fake provider takes webhooks only when
  `WINDKEEL_FAKE_BILLING_WEBHOOK_SECRET` (test-only) is set; otherwise its route answers 503.
- **Checkout and portal**: URLs on the provider's pages, returning only to the console's origin.

#### 5. Budgets, and where they are enforced

`organization_budget` (one per organization, or none — **no row is unlimited**): a monthly limit,
an alert threshold, a default per-run cap, and whether own-key spend counts. Spend against the budget
is the billable total plus the unpriced estimate (plus own-key spend when opted in). **At the limit is
exhausted**, so a limit of 0 refuses the first run.

- **Intake** (`src/billing/admission.ts`, called by `createTaskAndRun` and `startNewRun`, so every
  intake — API, label, Slack, Linear, Jira, signed webhook, schedule, *Run again*): refused with
  `OrganizationBudgetExhaustedError` (`org_budget_exhausted`) or `BillingAccountSuspendedError`
  (`billing_suspended`) **before any row is written**. The API answers 402; the GitHub label path
  records the reason and comments once; the intake pipeline records an ignore with the reason
  (2xx — a retry would be refused the same way).
- **Maker work** (`rails-gate.ts`): at the entry of the first implementation turn and of every
  repair turn, at every in-session rails poll, and at a fail verdict before a repair, an exhausted
  budget ends the run at `FAILED` with stop reason **`org_budget`**.
- **Never verification.** No verification is skipped, cut short or re-judged for budget: a
  candidate already produced is verified to its verdict, and the verdict stands; a `pass` still goes
  on to its pull request. The budget is consulted only *after* a verdict is saved: on a `fail`, the
  repair-loop rails check it before a repair, and an exhausted budget blocks the repair (`org_budget`)
  — it never changes the verdict. The overshoot is bounded, **per run in flight** when the budget runs out, by the maker
  turn already under way plus one verification — each run still held to its own ADR-0011 spend cap.
  A maker turn's model cost is recorded when the turn ends (`implementing.ts`, `repairing.ts`), so
  the in-session poll sees other runs' recorded spend, not the current turn's. Budget exhaustion can only *stop* work; no path moves a run toward `PR_READY` without a
  verdict, and none skips a check.
- **The per-run spend cap is not lowered to the remaining budget.** ADR-0011's cap is checked before
  a verification starts; a cap sized to what is left of the month would end a run *instead of*
  verifying its candidate the moment the budget ran out — the opposite of the decision above. The
  budget's own rail does that job at maker checkpoints instead. The organization's
  `default_run_cap_usd` still seeds a run that names no cap.
- **Suspended** refuses new runs; running runs continue to their verdict. `past_due` is shown and
  refuses nothing.

Alerts: each threshold crossed (the organization's percentage, and 100%) writes one `budget_alert`
row per period, raised by the sweep. Delivering them anywhere but the console is left for later.

#### 6. Configuration

`WINDKEEL_BILLING_PROVIDER` (`fake` | `stripe`, or `none`), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`STRIPE_METER_EVENT_NAME`, optional `STRIPE_PRICE_ID`, and the three price knobs. Stripe's meter is
priced per micro-USD (US$0.000001 per unit).

### Consequences

- Usage, budgets and billing exist without changing any deployment that does not opt in: no budget
  row, no billing account, the fake provider, no network.
- **Billing never affects a verdict**: nothing in the verification path calls the billing port or
  reads the budget; a provider outage delays an invoice, never a run.
- A new permission, `billing.manage` (Admin), guards the budget write, checkout and the portal. Usage
  and the budget are readable with `runs.read`.
- Concurrent intakes can all be admitted just under the limit; the maker-checkpoint rail stops each
  run at its next checkpoint, so the month can overshoot by up to one maker turn plus one
  verification per run in flight (§5). A precise reservation scheme was not worth a lock on every intake.
- A price knob changed mid-month re-prices the unreported remainder of that month; change them at a
  month boundary.
- Live Stripe proof waits for a Stripe test account (the conformance suite runs against Stripe's
  test mode when `STRIPE_TEST_SECRET_KEY` is set).
