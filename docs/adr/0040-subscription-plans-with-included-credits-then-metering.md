# ADR-0040: Subscription plans with included credits, then metering; out of credits is a hard stop

- Status: Accepted
- Date: 2026-10-27

## Context

ADR-0037 billed pure pay-as-you-go: usage metered from the ledger, held to an optional monthly budget.

## Decision

- §1 — The unit and the prices.
- §2 — Plans, packs and the trial.
- §3 — The ledger.
- §4 — Spend order, rollover, expiry.
- §5 — Out of credits.
- §6 — Stripe.
- §7 — Visibility.

## Consequences

- Prepaid credits make the common bill predictable, and the hard stop means no account is ever charged more than it bought unless an admin opted into overage, up to a cap they set.
- The overshoot after credits run out is bounded per run in flight by one maker step plus one verification (ADR-0037 §5's argument), and is never billed.
- Debits lag the ledger by up to a sweep; reads price the gap in memory, so nothing a person or the gate sees lags.
- A renewal leaves an account that spent its last period's credits at a hard stop until the new period's `invoice.paid` arrives (Stripe sends it within about an hour of renewal).

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-10-27
- Resolves: [#431 — Subscription plans with included credits, top-ups, overage cap, and spend visibility](https://github.com/jyothepro/orqon/issues/431)
  (the maintainer's decisions of 2026-10-27 in its body)
- Amends: [ADR-0037](0037-usage-billing-and-organization-budgets.md) (what an account on a plan is
  billed, and a second gate beside the budget) and
  [ADR-0038](0038-invite-only-self-serve-signup-makes-windkeel-multi-tenant.md) §4 (the trial is
  credits, not a first monthly budget)
- Builds on: [ADR-0013](0013-v1-observability-cost-ledger-transition-log-sql-views.md) and
  [ADR-0028](0028-every-model-call-is-recorded-at-a-boundary-windkeel-owns.md) (the cost ledger),
  [ADR-0026](0026-byok-org-sealed-model-credentials-and-a-per-run-model-snapshot.md) §9 (`key_source`)
- Leaves unchanged: [ADR-0004](0004-verification-runs-in-a-fresh-independent-sandbox.md) and
  [ADR-0029](0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md) — the
  verifier stays the gate
- Migration: `migrations/0050_credits.sql`; `migrations/0051_credit_debit_billed_overage.sql` (#439)

### Context

ADR-0037 billed pure pay-as-you-go: usage metered from the ledger, held to an optional monthly
budget. The maintainer chose **subscription plans with included credits, then metering**, and asked
that people can always see what they spent and on what.

### Decision

#### 1. The unit and the prices

**1 credit = US$0.01**, shown everywhere (console, CLI, API). Amounts are stored as integers of
micro-credits, so sums are exact.

| Line | Credits |
|---|---|
| Compute: maker and verifier sandbox time | **2 per sandbox-minute**, billed **per started second** of each charge (`ceil(ms/1000) × 2/60`) |
| AI on Windkeel's key | **at cost**: US$1 = 100 credits |
| AI on the organization's own key (BYOK) | 0 — that role pays compute only |
| Unpriced calls (#242) | 0 — never invoiced (ADR-0037 §2); shown on the receipt as unpriced |
| Verification | metered like everything else; **never waived** |

Per-second, not per-minute rounded up: a minute-rounded bill charges a 61-second verifier two
minutes, and verification runs are many and short. Sandbox time is the provider's reported figure
for the charge (`cost_event.sandbox_ms`, the delta `chargeSandboxUsage` already computes).

> **Amended 2026-11-09 (#439).** The maintainer's decision was 2 credits per *sandbox-minute*, and
> a sandbox holds its memory for its whole life, so compute is the sandbox's **wall clock from start
> to stop**, not its active CPU time (`SandboxUsage.wallClockMs`; Vercel: from the sandbox's
> `createdAt` to its stop). `cost_event.usd` stays the provider's CPU cost. And compute is rounded
> **once per run**, not per charge: a run's charges bill `ceil(total ms / 1000)` seconds and
> `computeMicro` of that, each charge paying the difference it makes to the run's total
> (`priceCostLines`), so 1.5 s + 2.5 s bills 4 s, not 5. Debits written before the amendment keep
> their amounts; a later charge never takes back what they paid.
ADR-0037's price knobs do not apply to an account on credits.

#### 2. Plans, packs and the trial

| Plan (monthly) | Price | Credits |
|---|---|---|
| Starter | $20 | 2,000 |
| Pro | $50 | 5,250 |
| Team | $100 | 11,000 |
| Scale | $250 | 30,000 |

Top-up packs, one time, no bonus: $10 → 1,000, $25 → 2,500, $50 → 5,000; they **expire 12 months**
after purchase. The trial is **500 credits, once, at signup, no card**, and expires like a top-up
(this replaces `WINDKEEL_TRIAL_CREDIT_USD`). No annual discount.

#### 3. The ledger

- **The cost ledger stays the source of truth for spend.** A `credit_debit` is one `cost_event` row
  priced in credits; its unique key is the cost line, so a line is debited once. A debit says
  which run, repository and role (maker, verifier, criteria) it was for.
- **Grants** (`credit_grant`) — plan period, upgrade difference, top-up, trial — each have an
  amount, a window, a source and an idempotency key on the provider object that paid for them
  (`invoice`, checkout session, `trial:<account>`). The same event twice grants once; so do two
  different events for one invoice.
- **No balance is stored.** A grant's remainder is its amount minus its allocations
  (`credit_allocation`). Cost lines the sweep has not yet written as debits are priced and
  allocated in memory by the same function, so the gate and the console are exact without
  writing anything; the hourly sweep writes the debits under a lock on the account.
- An account is on credits from `billing_account.credit_billing_since`; cost before it was billed
  the ADR-0037 way and is never debited. Existing accounts are unchanged until they subscribe.

#### 4. Spend order, rollover, expiry

**Plan credits first** (the period's, then any upgrade's difference), **then top-ups and the
trial, oldest expiry first**, **then overage**. A line spends only grants live when it was
recorded. Plan credits are granted for exactly the paid period and **reset** with it: no rollover.

#### 5. Out of credits

A **hard stop by default**. Intake refuses a new run with `CreditsExhaustedError`
(`credits_exhausted`, 402) — every intake, through the same `admitRun` as ADR-0037's budget, which
still applies beside it. A run in flight stops at its next maker checkpoint with ADR-0037's
`org_budget` stop reason, after the step under way; **no verification is skipped, cut short or
re-judged for credits**, and a pass still goes on to its pull request. What the step under way
spends past the last credit is recorded as overage and **not billed**.

An admin can turn **overage on with a monthly cap** (`PUT /v1/billing/overage`); a cap is required, and so is a plan subscription — overage is
invoiced on the subscription's metered price, so an account with only the trial or top-ups cannot
turn it on, and it goes off when the subscription ends.
From the moment it is on, spend past the last credit is billed overage, and runs are admitted
until it reaches the cap (at the cap is reached). Billed overage is reported on ADR-0037's Stripe
meter, in micro-USD (1 credit = 10,000), with ADR-0037 §4's idempotency; plan and top-up credits
are prepaid and never metered.

> **Amended 2026-11-09 (#439).** Billed overage is **clamped at the cap**: a step already under way
> when the cap is reached runs on, and what it spends past the cap is recorded as unbilled overage.
> One cost line can cross the cap, so a debit carries how much of its overage is billed
> (`credit_debit.overage_billable_micro`, migration 0051). A change to overage or its cap first
> writes the debits for cost already recorded, so cost is judged by the cap it ran under: raising a
> cap never bills what ran past the old one.

#### 6. Stripe

- Checkout per plan (`mode=subscription`, with ADR-0037's metered price `STRIPE_PRICE_ID` as a
  second line so overage has somewhere to bill) and per pack (`mode=payment`), the account and
  product in the session's metadata. Prices: `STRIPE_PRICE_STARTER|PRO|TEAM|SCALE` and
  `STRIPE_PRICE_TOPUP_10|25|50`, required with `WINDKEEL_BILLING_PROVIDER=stripe` (doctor and
  `/api/preflight` fail by name). The fake provider uses `price_fake_<key>`.

  > **Amended 2026-11-09 (#439).** `STRIPE_PRICE_ID` is **required** with
  > `WINDKEEL_BILLING_PROVIDER=stripe` too (it was optional in ADR-0037 §6). Without it a plan
  > subscription had no metered line, so overage was reported to the meter and never invoiced. Of
  > the two fixes — refuse the configuration, or refuse overage while the price is unset — this is
  > the smaller and the safer: one more name on the list doctor and `/api/preflight` already check,
  > no new branch on the money path, and no state in which overage (or ADR-0037's pay-as-you-go
  > usage, which bills on the same price) accrues with nothing to invoice it. Every plan checkout
  > now carries it, and a checkout with no plan subscribes to it instead of only saving a card.
- Webhooks: `checkout.session.completed` (a paid pack is granted; a subscription moves the
  account onto credits), `invoice.paid` with `billing_reason` `subscription_create` or
  `subscription_cycle` (the period's plan credits; a proration invoice grants nothing),
  `customer.subscription.created|updated` (plan changes), `customer.subscription.deleted` (no plan
  from now; paid credits stay until they expire), `invoice.payment_failed` (ADR-0037's status only).
  A plan change from an event older than the last one applied is ignored (ADR-0037 §4's ordering).
- **Upgrade takes effect now**: the provider prorates the money (`always_invoice`); Windkeel grants
  the credit difference for the rest of the period, once per period and target plan.
  **Downgrade at period end**: no proration; recorded as pending, and the next period's invoice —
  the first at the lower price — grants the lower plan's credits and makes it the plan.

#### 7. Visibility

- **Receipt** (`GET /v1/runs/{id}/receipt`, on `GET /v1/runs/{id}`, and under `windkeel show`):
  sandbox minutes × 2 per role, AI tokens → credits per role and model, the total. Equal to the
  run's debits once they are written.
- **Balance** (`GET /v1/billing/balance`, `windkeel billing`): plan credits left, top-ups and their
  expiry, overage billed and unbilled against the cap, days to reset, this period's alerts.
- **Alerts**: 50%, 80% and 100% of plan credits, and the overage cap, **once per threshold per
  period** (`credit_alert`'s key), raised by the sweep — the path ADR-0037's budget alerts take.
- **Statement** (`GET /v1/billing/statement?period=YYYY-MM[&format=csv]`, `windkeel billing
  statement`): the month by run, repository and role.

### Consequences

- Prepaid credits make the common bill predictable, and the hard stop means no account is ever
  charged more than it bought unless an admin opted into overage, up to a cap they set.
- The overshoot after credits run out is bounded per run in flight by one maker step plus one
  verification (ADR-0037 §5's argument), and is never billed.
- Debits lag the ledger by up to a sweep; reads price the gap in memory, so nothing a person or the
  gate sees lags. A late-committing cost line is allocated when it is seen, in its own time's
  grants.
- A renewal leaves an account that spent its last period's credits at a hard stop until the new
  period's `invoice.paid` arrives (Stripe sends it within about an hour of renewal).
- Delivering alerts beyond the console and the sweep's log (email) and the console's credit views
  are left for follow-ups; live Stripe products and keys are #428.
