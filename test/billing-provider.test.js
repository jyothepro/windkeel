/**
 * #394 / ADR-0037 §4: the billing seam. The same contract for the fake, for the Stripe adapter
 * against an offline Stripe stub, and for the Stripe adapter against Stripe's test mode when
 * `STRIPE_TEST_SECRET_KEY` is set; then the report sweep — usage reported exactly once per amount,
 * a failure retried with the same key, nothing double-counted.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { billingConfigProblem, loadBillingConfig } from "../dist/factory/config/billing.js";
import { FakeBillingProvider } from "../dist/billing/fake.js";
import { billingProviderFromConfig } from "../dist/billing/index.js";
import { reportPendingUsage } from "../dist/billing/report.js";
import { StripeBillingProvider } from "../dist/billing/stripe.js";
import { parseEventBody, signPayload, verifySignedPayload, WebhookSignatureError } from "../dist/billing/provider.js";
import { setBudget } from "../dist/billing/budget.js";
import { billingConformance, fakeStripeApi } from "./billing-conformance.js";
import { cost, createOrganization, defaultOrganization, runIn, skip, withSchema } from "./billing-fixtures.js";

const STRIPE_PRICES = {
  STRIPE_PRICE_STARTER: "price_starter",
  STRIPE_PRICE_PRO: "price_pro",
  STRIPE_PRICE_TEAM: "price_team",
  STRIPE_PRICE_SCALE: "price_scale",
  STRIPE_PRICE_TOPUP_10: "price_t10",
  STRIPE_PRICE_TOPUP_25: "price_t25",
  STRIPE_PRICE_TOPUP_50: "price_t50",
};

billingConformance("fake", async () => {
  const provider = new FakeBillingProvider("whsec_test_fake");
  return { provider, webhookSecret: "whsec_test_fake", accepted: (id) => provider.totalFor(id) };
});

billingConformance("stripe (offline stub)", async () => {
  const api = fakeStripeApi("sk_test_stub");
  const provider = new StripeBillingProvider(
    { secretKey: "sk_test_stub", webhookSecret: "whsec_test_stripe", meterEventName: "windkeel_usage", apiBase: "https://api.stripe.test" },
    api.fetchImpl,
  );
  return { provider, webhookSecret: "whsec_test_stripe", accepted: api.accepted };
});

/*
 * Test mode only: a key that is not `sk_test_…` (a live `sk_live_…` or restricted `rk_live_…` key
 * pasted into the wrong variable) is never used — the suite would otherwise send real meter events.
 */
const testModeKey = process.env.STRIPE_TEST_SECRET_KEY;
const liveKey = testModeKey?.startsWith("sk_test_") ? testModeKey : undefined;
billingConformance(
  "stripe (test mode)",
  async () => ({
    provider: new StripeBillingProvider({
      secretKey: liveKey,
      webhookSecret: "whsec_conformance_local",
      meterEventName: process.env.STRIPE_TEST_METER_EVENT_NAME ?? "windkeel_usage",
      apiBase: "https://api.stripe.com",
    }),
    webhookSecret: "whsec_conformance_local",
    accepted: null,
  }),
  {
    skip: liveKey
      ? false
      : testModeKey
        ? "STRIPE_TEST_SECRET_KEY is not a test-mode key (sk_test_…); refusing to call Stripe with it"
        : "STRIPE_TEST_SECRET_KEY not set",
  },
);

test("the adapter sends Stripe what the meter needs: integer micro-USD, the identifier, the customer", async () => {
  const api = fakeStripeApi("sk_test_stub");
  const provider = new StripeBillingProvider(
    { secretKey: "sk_test_stub", webhookSecret: "w", meterEventName: "windkeel_usage", apiBase: "https://api.stripe.test", priceId: "price_123" },
    api.fetchImpl,
  );
  await provider.reportUsage({
    customerId: "cus_a",
    organizationId: "org-1",
    periodStart: new Date(),
    periodEnd: new Date(),
    amountMicroUsd: 42,
    idempotencyKey: "org-1:2026-10:7",
    timestamp: new Date("2026-10-15T00:00:00Z"),
  });
  const sent = api.requests.find((r) => r.path === "/v1/billing/meter_events");
  assert.equal(sent.form.event_name, "windkeel_usage");
  assert.equal(sent.form.identifier, "org-1:2026-10:7");
  assert.equal(sent.form["payload[value]"], "42");
  assert.equal(sent.form["payload[stripe_customer_id]"], "cus_a");
  assert.equal(sent.form.timestamp, String(Date.parse("2026-10-15T00:00:00Z") / 1000));
  assert.equal(sent.headers["idempotency-key"], "windkeel-usage-org-1:2026-10:7");
  assert.match(await provider.checkoutUrl({ customerId: "cus_a", returnUrl: "https://c/x" }), /mode=subscription/);
});

test("a Stripe error is reported by type and status, never with Stripe's message or the key", async () => {
  const provider = new StripeBillingProvider(
    { secretKey: "sk_test_secret_value", webhookSecret: "w", meterEventName: "m", apiBase: "https://api.stripe.test" },
    async () => ({ status: 400, json: async () => ({ error: { type: "invalid_request_error", message: "No such customer: cus_sk_test_secret_value" } }) }),
  );
  await assert.rejects(provider.ensureCustomer({ accountId: "a", name: "n" }), (error) => {
    assert.match(error.message, /answered 400 \(invalid_request_error\)/);
    assert.ok(!error.message.includes("sk_test_secret_value"));
    assert.equal(error.retryable, false);
    return true;
  });
});

test("WINDKEEL_BILLING_PROVIDER: the fake by default; stripe without its keys fails by name", () => {
  assert.equal(loadBillingConfig({}).provider, "fake");
  assert.equal(billingProviderFromConfig(loadBillingConfig({})).name, "fake");
  assert.equal(billingProviderFromConfig(loadBillingConfig({ WINDKEEL_BILLING_PROVIDER: "none" })), null);
  assert.throws(
    () => loadBillingConfig({ WINDKEEL_BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_x" }),
    /WINDKEEL_BILLING_PROVIDER=stripe needs STRIPE_WEBHOOK_SECRET, STRIPE_METER_EVENT_NAME/,
  );
  const problem = billingConfigProblem({ WINDKEEL_BILLING_PROVIDER: "stripe" });
  assert.equal(problem.ok, false);
  assert.match(problem.summary, /STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_METER_EVENT_NAME/);
  assert.throws(() => loadBillingConfig({ WINDKEEL_BILLING_PROVIDER: "paypal" }), /must be fake or stripe/);
  const keys = {
    WINDKEEL_BILLING_PROVIDER: "stripe",
    STRIPE_SECRET_KEY: "sk_test_x",
    STRIPE_WEBHOOK_SECRET: "whsec_x",
    STRIPE_METER_EVENT_NAME: "windkeel_usage",
    STRIPE_PRICE_ID: "price_metered",
  };
  // #431 / ADR-0040: the plans' and packs' prices are what an account buys, so stripe needs them too.
  assert.throws(() => loadBillingConfig(keys), /needs STRIPE_PRICE_STARTER, STRIPE_PRICE_PRO, STRIPE_PRICE_TEAM, STRIPE_PRICE_SCALE, STRIPE_PRICE_TOPUP_10, STRIPE_PRICE_TOPUP_25, STRIPE_PRICE_TOPUP_50/);
  const full = loadBillingConfig({ ...keys, ...STRIPE_PRICES });
  assert.equal(billingProviderFromConfig(full).name, "stripe");
  assert.equal(full.prices.plans.pro, "price_pro");
  assert.equal(full.prices.topups.topup_25, "price_t25");
  // The fake names its own prices for any it is not given.
  assert.equal(loadBillingConfig({}).prices.plans.starter, "price_fake_starter");
  assert.match(billingConfigProblem({ ...keys, ...STRIPE_PRICES }).summary, /credit plans and top-ups: 7 of 7 priced/);
  assert.ok(!JSON.stringify(billingConfigProblem({ WINDKEEL_BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_x" })).includes("sk_test_x"));
});

test("#439: stripe needs STRIPE_PRICE_ID, the metered price overage is invoiced on, and refuses by name without it", async () => {
  const keys = {
    WINDKEEL_BILLING_PROVIDER: "stripe",
    STRIPE_SECRET_KEY: "sk_test_x",
    STRIPE_WEBHOOK_SECRET: "whsec_x",
    STRIPE_METER_EVENT_NAME: "windkeel_usage",
    ...STRIPE_PRICES,
  };
  assert.throws(() => loadBillingConfig(keys), /WINDKEEL_BILLING_PROVIDER=stripe needs STRIPE_PRICE_ID, which is not set/);
  const problem = billingConfigProblem(keys);
  assert.equal(problem.ok, false);
  assert.match(problem.summary, /STRIPE_PRICE_ID/);
  const config = loadBillingConfig({ ...keys, STRIPE_PRICE_ID: "price_metered" });
  assert.equal(config.stripe.priceId, "price_metered");

  const api = fakeStripeApi("sk_test_stub");
  const provider = new StripeBillingProvider({ ...config.stripe, secretKey: "sk_test_stub", apiBase: "https://api.stripe.test" }, api.fetchImpl);
  await provider.checkoutUrl({
    customerId: "cus_a",
    accountId: "acct-1",
    returnUrl: "https://c/x",
    purchase: { kind: "plan", plan: "pro", priceId: "price_pro" },
  });
  const plan = api.requests.filter((r) => r.path === "/v1/checkout/sessions").at(-1).form;
  assert.deepEqual([plan.mode, plan["line_items[0][price]"], plan["line_items[1][price]"]], ["subscription", "price_pro", "price_metered"], "every plan subscription can carry overage");
  await provider.checkoutUrl({ customerId: "cus_a", returnUrl: "https://c/x" });
  const payg = api.requests.filter((r) => r.path === "/v1/checkout/sessions").at(-1).form;
  assert.deepEqual([payg.mode, payg["line_items[0][price]"]], ["subscription", "price_metered"], "pay-as-you-go subscribes to the metered price, never a card-only setup");
});

test("the fake provider has no default webhook secret: without WINDKEEL_FAKE_BILLING_WEBHOOK_SECRET it accepts none", () => {
  const unset = billingProviderFromConfig(loadBillingConfig({}));
  assert.equal(unset.acceptsWebhooks, false);
  // The secret that used to be the default, in the source for anyone to read, no longer signs anything.
  const body = JSON.stringify({ id: "evt_forged", type: "invoice.paid", data: { object: { customer: "cus_x" } } });
  assert.throws(() => unset.parseWebhook(body, signPayload(body, "whsec_windkeel_fake_local_only")), WebhookSignatureError);
  assert.throws(() => unset.webhook({ id: "e", type: "invoice.paid", object: {} }), WebhookSignatureError);

  const set = billingProviderFromConfig(loadBillingConfig({ WINDKEEL_FAKE_BILLING_WEBHOOK_SECRET: "whsec_test_only" }));
  assert.equal(set.acceptsWebhooks, true);
  assert.equal(set.parseWebhook(body, signPayload(body, "whsec_test_only")).id, "evt_forged");
  assert.equal(new StripeBillingProvider({ secretKey: "sk", webhookSecret: "w", meterEventName: "m", apiBase: "https://api.stripe.test" }).acceptsWebhooks, true);
});

test("the webhook signature covers the raw bytes: two bodies that decode alike do not share a signature", () => {
  // Different invalid UTF-8 bytes both decode to U+FFFD; an HMAC over the decoded text would match both.
  const signed = Buffer.concat([Buffer.from('{"id":"evt_1","type":"invoice.paid","x":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  const swapped = Buffer.concat([Buffer.from('{"id":"evt_1","type":"invoice.paid","x":"'), Buffer.from([0xfe]), Buffer.from('"}')]);
  assert.equal(signed.toString("utf8"), swapped.toString("utf8"), "the precondition: they decode alike");
  const now = new Date();
  const signature = signPayload(signed, "whsec_raw", now);
  verifySignedPayload(signed, signature, "whsec_raw", now);
  assert.throws(() => verifySignedPayload(swapped, signature, "whsec_raw", now), WebhookSignatureError);
  // A string body is its UTF-8 bytes, so the two forms of one body agree.
  verifySignedPayload("{\"a\":\"é\"}", signPayload(Buffer.from("{\"a\":\"é\"}", "utf8"), "whsec_raw", now), "whsec_raw", now);
});

test("subscription events take their status from the subscription object; deleted and canceled are terminal", () => {
  const sub = (status) => JSON.stringify({ id: `evt_${status}`, type: "customer.subscription.updated", created: 1_700_000_000, data: { object: { customer: "cus_x", status } } });
  assert.deepEqual(pick(parseEventBody(sub("active"))), { status: "active", source: "subscription", ended: false, created: 1_700_000_000_000 });
  assert.deepEqual(pick(parseEventBody(sub("canceled"))), { status: "suspended", source: "subscription", ended: true, created: 1_700_000_000_000 });
  assert.deepEqual(pick(parseEventBody(sub("unpaid"))), { status: "suspended", source: "subscription", ended: false, created: 1_700_000_000_000 });
  const deleted = parseEventBody(JSON.stringify({ id: "e", type: "customer.subscription.deleted", data: { object: { customer: "cus_x", status: "canceled" } } }));
  assert.deepEqual([deleted.status, deleted.ended, deleted.created], ["suspended", true, null]);
  const paid = parseEventBody(JSON.stringify({ id: "e", type: "invoice.paid", data: { object: { customer: "cus_x" } } }));
  assert.deepEqual([paid.status, paid.source, paid.ended], ["active", "invoice", false]);
});

const pick = (e) => ({ status: e.status, source: e.source, ended: e.ended, created: e.created?.getTime() ?? null });

// --- the report sweep ------------------------------------------------------------------------

const NOW = new Date("2026-10-20T12:00:00Z");
const EARLIER = new Date("2026-10-20T11:00:00Z");

test("usage is reported once per high-water mark; a second sweep sends nothing; new spend sends the increment", { skip }, async () => {
  await withSchema("billing_report_once", async (pool) => {
    const acme = await createOrganization(pool, "acme", { billing: { provider: "fake", plan: "managed" } });
    const internal = await defaultOrganization(pool); // provider none: never reported
    const provider = new FakeBillingProvider();
    const { runId } = await runIn(pool, acme.organizationId, acme.repositoryId);
    await cost(pool, runId, { usd: 1.5, keySource: "orqon" }, EARLIER);
    await cost(pool, runId, { usd: null, tokensIn: 100, tokensOut: 10, keySource: "orqon", model: "x" }, EARLIER);
    const { runId: defaultRun } = await runIn(pool, internal.organizationId, "11111111-1111-1111-1111-111111111111");
    await cost(pool, defaultRun, { usd: 50, keySource: "orqon" }, EARLIER);

    const first = await reportPendingUsage({ pool, provider, now: NOW });
    assert.equal(first.reports.length, 1);
    assert.deepEqual(
      [first.reports[0].status, first.reports[0].amountMicroUsd, first.reports[0].retry],
      ["sent", 1_500_000, false],
      "the billable sum, unpriced excluded",
    );
    const [customer] = [...provider.customers.values()];
    assert.equal(provider.totalFor(customer.customerId), 1_500_000);

    const second = await reportPendingUsage({ pool, provider, now: NOW });
    assert.equal(second.reports.length, 0, "nothing new, nothing sent");

    // A cost inside the horizon waits; once it is older, only the increment goes.
    await cost(pool, runId, { usd: 0.25, keySource: "orqon" }, new Date(NOW.getTime() - 5_000));
    assert.equal((await reportPendingUsage({ pool, provider, now: NOW })).reports.length, 0, "inside the one-minute horizon");
    const later = new Date(NOW.getTime() + 120_000);
    const third = await reportPendingUsage({ pool, provider, now: later });
    assert.deepEqual(third.reports.map((r) => r.amountMicroUsd), [250_000]);
    assert.equal(provider.totalFor(customer.customerId), 1_750_000, "increments sum to the month's billable total");

    const { rows } = await pool.query("select status, unpriced_calls, cumulative_micro_usd from usage_report order by created_at");
    assert.deepEqual(rows.map((r) => [r.status, Number(r.cumulative_micro_usd)]), [["sent", 1_500_000], ["sent", 1_750_000]]);
    assert.equal(rows[0].unpriced_calls, 1, "unpriced calls are reported as a count");
    const defaultReports = await pool.query("select 1 from usage_report where organization_id = $1", [internal.organizationId]);
    assert.equal(defaultReports.rowCount, 0, "the internal account is never billed");
  });
});

test("a failed send is retried next sweep with the same key and amount, before anything new", { skip }, async () => {
  await withSchema("billing_report_retry", async (pool) => {
    const acme = await createOrganization(pool, "acme", { billing: { provider: "fake" } });
    const provider = new FakeBillingProvider();
    const { runId } = await runIn(pool, acme.organizationId, acme.repositoryId);
    await cost(pool, runId, { usd: 2, keySource: "orqon" }, EARLIER);

    provider.failNextReports = 1;
    const failed = await reportPendingUsage({ pool, provider, now: NOW });
    assert.deepEqual(failed.reports.map((r) => r.status), ["failed"]);
    const { rows: afterFail } = await pool.query("select status, attempts, last_error, idempotency_key from usage_report");
    assert.equal(afterFail[0].status, "failed");
    assert.equal(afterFail[0].attempts, 1);
    assert.match(afterFail[0].last_error, /simulated failure/);

    // More spend arrives before the retry: the retry still goes first, alone, with its own amount.
    await cost(pool, runId, { usd: 1, keySource: "orqon" }, EARLIER);
    const retried = await reportPendingUsage({ pool, provider, now: NOW });
    assert.deepEqual(
      retried.reports.map((r) => [r.idempotencyKey === afterFail[0].idempotency_key, r.amountMicroUsd, r.retry, r.status]),
      [[true, 2_000_000, true, "sent"], [false, 1_000_000, false, "sent"]],
    );
    const [customer] = [...provider.customers.values()];
    assert.equal(provider.totalFor(customer.customerId), 3_000_000, "the high-water mark does not double count");
    assert.equal((await reportPendingUsage({ pool, provider, now: NOW })).reports.length, 0);
  });
});

test("the BYOK plan is billed the compute fee, not its own-key AI", { skip }, async () => {
  await withSchema("billing_report_byok", async (pool) => {
    const acme = await createOrganization(pool, "acme", { billing: { provider: "fake", plan: "byok" } });
    const { credential, workspace } = await import("./billing-fixtures.js");
    const key = await credential(pool, acme.organizationId);
    const provider = new FakeBillingProvider();
    const { runId } = await runIn(pool, acme.organizationId, acme.repositoryId);
    const verifier = await workspace(pool, runId, "verifier");
    await cost(pool, runId, { usd: 9, keySource: "customer", credentialId: key }, EARLIER);
    await cost(pool, runId, { stageType: "workspace", stageId: verifier, kind: "sandbox", usd: 0.4 }, EARLIER);
    const result = await reportPendingUsage({
      pool,
      provider,
      now: NOW,
      pricing: { aiMultiplier: 1, computeMultiplier: 1.5, verificationFeeUsd: 0 },
    });
    assert.deepEqual(result.reports.map((r) => r.amountMicroUsd), [600_000], "compute fee 0.4 × 1.5; own-key spend not billed");
  });
});

test("the sweep raises a budget alert once when spend crosses the threshold", { skip }, async () => {
  await withSchema("billing_report_alert", async (pool) => {
    const acme = await createOrganization(pool, "acme", { billing: { provider: "fake" } });
    await setBudget(pool, acme.organizationId, { monthlyLimitUsd: 10, alertThresholdPct: 50 }, null);
    const provider = new FakeBillingProvider();
    const { runId } = await runIn(pool, acme.organizationId, acme.repositoryId);
    await cost(pool, runId, { usd: 6, keySource: "orqon" }, EARLIER);
    assert.deepEqual((await reportPendingUsage({ pool, provider, now: NOW })).alerts, [{ organizationId: acme.organizationId, thresholdPct: 50 }]);
    assert.deepEqual((await reportPendingUsage({ pool, provider, now: NOW })).alerts, []);
  });
});
