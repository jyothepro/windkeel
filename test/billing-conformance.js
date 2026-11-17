/**
 * The `BillingProvider` contract (ADR-0037 §4), run against every implementation — the pattern of
 * `github-conformance.js`. The fake and the Stripe adapter must behave the same where Windkeel relies
 * on it: a customer is created once, a usage report is deduplicated on its idempotency key, and a
 * webhook is accepted only with a valid, fresh signature over the exact bytes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { signPayload, WebhookSignatureError } from "../dist/billing/provider.js";

/**
 * @param name a label for the test titles
 * @param make () => ({ provider, webhookSecret, accepted(customerId) => micro-USD total accepted })
 */
export function billingConformance(name, make, { skip = false } = {}) {
  test(`${name}: ensureCustomer is idempotent per account`, { skip }, async () => {
    const { provider } = await make();
    const first = await provider.ensureCustomer({ accountId: "acct-1", name: "Acme" });
    const again = await provider.ensureCustomer({ accountId: "acct-1", name: "Acme", existingCustomerId: first.customerId });
    assert.match(first.customerId, /^cus_/);
    assert.equal(again.customerId, first.customerId);
  });

  test(`${name}: a usage report is deduplicated on its idempotency key`, { skip }, async () => {
    const { provider, accepted } = await make();
    const { customerId } = await provider.ensureCustomer({ accountId: "acct-2", name: "Acme" });
    const report = {
      customerId,
      organizationId: "org-1",
      periodStart: new Date("2026-10-01T00:00:00Z"),
      periodEnd: new Date("2026-11-01T00:00:00Z"),
      amountMicroUsd: 1_250_000,
      idempotencyKey: "org-1:2026-10:42",
      timestamp: new Date(),
    };
    const one = await provider.reportUsage(report);
    const two = await provider.reportUsage(report);
    assert.equal(two.ref, one.ref);
    await provider.reportUsage({ ...report, amountMicroUsd: 500_000, idempotencyKey: "org-1:2026-10:43" });
    if (accepted) assert.equal(await accepted(customerId), 1_750_000, "the duplicate is not counted");
    await assert.rejects(provider.reportUsage({ ...report, amountMicroUsd: 0, idempotencyKey: "zero" }), /positive integer/);
  });

  test(`${name}: checkout and portal answer the provider's URL`, { skip }, async () => {
    const { provider } = await make();
    const { customerId } = await provider.ensureCustomer({ accountId: "acct-3", name: "Acme" });
    assert.match(await provider.checkoutUrl({ customerId, returnUrl: "https://console.example/settings/billing" }), /^https:\/\//);
    assert.match(await provider.portalUrl({ customerId, returnUrl: "https://console.example/settings/billing" }), /^https:\/\//);
  });

  test(`${name}: a webhook is accepted only with a fresh signature over the exact body`, { skip }, async () => {
    const { provider, webhookSecret } = await make();
    const body = JSON.stringify({ id: "evt_1", type: "invoice.payment_failed", data: { object: { customer: "cus_x" } } });
    const now = new Date();
    const event = provider.parseWebhook(body, signPayload(body, webhookSecret, now), now);
    assert.deepEqual(event, {
      id: "evt_1",
      type: "invoice.payment_failed",
      customerId: "cus_x",
      created: null,
      status: "past_due",
      source: "invoice",
      ended: false,
      object: { customer: "cus_x" },
    });

    assert.throws(() => provider.parseWebhook(body, signPayload(body, "whsec_wrong", now), now), WebhookSignatureError);
    assert.throws(() => provider.parseWebhook(`${body} `, signPayload(body, webhookSecret, now), now), WebhookSignatureError, "one byte changed");
    assert.throws(() => provider.parseWebhook(body, undefined, now), WebhookSignatureError);
    assert.throws(() => provider.parseWebhook(body, "t=abc,v1=zz", now), WebhookSignatureError);
    const stale = new Date(now.getTime() - 10 * 60_000);
    assert.throws(() => provider.parseWebhook(body, signPayload(body, webhookSecret, stale), now), /tolerance/, "a replay ten minutes later");
  });
}

/**
 * Enough of Stripe's REST API to drive the adapter offline: customers (idempotent on the
 * `Idempotency-Key` header), meter events (deduplicated on `identifier`, as Stripe does), and the
 * two session endpoints. It also checks the adapter authenticates and form-encodes.
 */
export function fakeStripeApi(secretKey) {
  const customers = new Map();
  const meterEvents = new Map();
  const requests = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const form = Object.fromEntries(new URLSearchParams(init.body ?? ""));
    requests.push({ path, form, headers: init.headers });
    const reply = (status, body) => ({ status, json: async () => body });
    if (init.headers.authorization !== `Bearer ${secretKey}`) return reply(401, { error: { type: "invalid_request_error" } });
    if (init.headers["content-type"] !== "application/x-www-form-urlencoded") return reply(400, { error: { type: "invalid_request_error" } });
    switch (path) {
      case "/v1/customers": {
        const key = init.headers["idempotency-key"];
        if (!customers.has(key)) customers.set(key, { id: `cus_stub${customers.size + 1}`, name: form.name });
        return reply(200, customers.get(key));
      }
      case "/v1/billing/meter_events": {
        if (!form.event_name || !form.identifier || !/^\d+$/.test(form["payload[value]"] ?? "")) return reply(400, { error: { type: "invalid_request_error" } });
        if (!meterEvents.has(form.identifier)) meterEvents.set(form.identifier, form);
        return reply(200, { identifier: form.identifier, event_name: form.event_name });
      }
      case "/v1/checkout/sessions":
        return reply(200, { url: `https://checkout.stripe.test/c/${form.customer}?mode=${form.mode}` });
      case "/v1/billing_portal/sessions":
        return reply(200, { url: `https://billing.stripe.test/p/${form.customer}` });
      default:
        return reply(404, { error: { type: "invalid_request_error" } });
    }
  };
  const accepted = (customerId) =>
    [...meterEvents.values()]
      .filter((e) => e["payload[stripe_customer_id]"] === customerId)
      .reduce((sum, e) => sum + Number(e["payload[value]"]), 0);
  return { fetchImpl, requests, accepted, meterEvents };
}
