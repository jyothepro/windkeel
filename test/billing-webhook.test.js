/**
 * #394 / ADR-0037 §4: the billing webhook handler. Bad signature 401 and nothing written; a replay
 * is a no-op; a stale timestamp is refused even when correctly signed; `past_due`, `active` and
 * `suspended` transitions land on the account the customer id names, and nowhere else.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeBillingProvider } from "../dist/billing/fake.js";
import { signPayload } from "../dist/billing/provider.js";
import { handleBillingWebhook } from "../dist/billing/webhook.js";
import { createOrganization, skip, withSchema } from "./billing-fixtures.js";

const SECRET = "whsec_webhook_test";

async function billed(pool) {
  const acme = await createOrganization(pool, "acme", { billing: { provider: "fake" } });
  const other = await createOrganization(pool, "other", { billing: { provider: "fake" } });
  await pool.query("update billing_account set provider_customer_id = 'cus_acme' where account_id = $1", [acme.accountId]);
  await pool.query("update billing_account set provider_customer_id = 'cus_other' where account_id = $1", [other.accountId]);
  return { acme, other };
}

const statusOf = async (pool, accountId) =>
  (await pool.query("select status from billing_account where account_id = $1", [accountId])).rows[0].status;

test("a bad or missing signature is 401 and changes nothing", { skip }, async () => {
  await withSchema("billing_webhook_bad", async (pool) => {
    const { acme } = await billed(pool);
    const provider = new FakeBillingProvider(SECRET);
    const body = JSON.stringify({ id: "evt_1", type: "customer.subscription.deleted", data: { object: { customer: "cus_acme" } } });
    for (const signature of [undefined, "garbage", signPayload(body, "whsec_other"), signPayload(`${body}x`, SECRET)]) {
      const result = await handleBillingWebhook(pool, provider, "fake", body, signature);
      assert.equal(result.status, 401);
      assert.equal(result.body.code, "bad_signature");
    }
    assert.equal(await statusOf(pool, acme.accountId), "active");
    assert.equal((await pool.query("select 1 from billing_webhook_event")).rowCount, 0);
  });
});

test("a stale timestamp is refused even with a valid signature", { skip }, async () => {
  await withSchema("billing_webhook_stale", async (pool) => {
    const { acme } = await billed(pool);
    const provider = new FakeBillingProvider(SECRET);
    const now = new Date("2026-10-21T12:00:00Z");
    const old = provider.webhook({ id: "evt_old", type: "invoice.payment_failed", object: { customer: "cus_acme" } }, new Date(now.getTime() - 3_600_000));
    assert.equal((await handleBillingWebhook(pool, provider, "fake", old.body, old.signature, now)).status, 401);
    assert.equal(await statusOf(pool, acme.accountId), "active");
  });
});

test("past_due, active and suspended land on the right account; a replay is a no-op", { skip }, async () => {
  await withSchema("billing_webhook_transitions", async (pool) => {
    const { acme, other } = await billed(pool);
    const provider = new FakeBillingProvider(SECRET);
    const deliver = async (id, type, object) => {
      const { body, signature } = provider.webhook({ id, type, object });
      return handleBillingWebhook(pool, provider, "fake", Buffer.from(body), signature);
    };

    assert.equal((await deliver("evt_1", "invoice.payment_failed", { customer: "cus_acme" })).body.status, "past_due");
    assert.equal(await statusOf(pool, acme.accountId), "past_due");
    assert.equal(await statusOf(pool, other.accountId), "active", "another customer's account is untouched");

    assert.equal((await deliver("evt_2", "invoice.paid", { customer: "cus_acme" })).body.status, "active");
    assert.equal(await statusOf(pool, acme.accountId), "active");

    // The first delivery again — Stripe retries — does nothing, even though it would change the status.
    const replay = await deliver("evt_1", "invoice.payment_failed", { customer: "cus_acme" });
    assert.deepEqual([replay.status, replay.body.duplicate], [200, true]);
    assert.equal(await statusOf(pool, acme.accountId), "active");

    await deliver("evt_3", "customer.subscription.updated", { customer: "cus_acme", status: "unpaid" });
    assert.equal(await statusOf(pool, acme.accountId), "suspended");
    const { rows } = await pool.query("select status_reason from billing_account where account_id = $1", [acme.accountId]);
    assert.match(rows[0].status_reason, /customer\.subscription\.updated \(evt_3\)/);

    // An event Windkeel does not act on is recorded and changes nothing.
    const ignored = await deliver("evt_4", "customer.created", { customer: "cus_acme" });
    assert.deepEqual([ignored.status, ignored.body.applied], [200, false]);
    assert.equal((await pool.query("select 1 from billing_webhook_event")).rowCount, 4);
  });
});

test("the fake provider without WINDKEEL_FAKE_BILLING_WEBHOOK_SECRET refuses every webhook, before the database", async () => {
  const provider = new FakeBillingProvider(); // what the default deployment builds
  const body = JSON.stringify({ id: "evt_forged", type: "invoice.paid", data: { object: { customer: "cus_acme" } } });
  // Signed with the secret that used to be the fake's public default.
  const result = await handleBillingWebhook(null, provider, "fake", body, signPayload(body, "whsec_windkeel_fake_local_only"));
  assert.equal(result.status, 503);
  assert.equal(result.body.code, "webhooks_disabled");
});

test("out of order: a late invoice.paid does not undo a newer payment failure", { skip }, async () => {
  await withSchema("billing_webhook_order_paid", async (pool) => {
    const { acme } = await billed(pool);
    const provider = new FakeBillingProvider(SECRET);
    const t = (s) => new Date(Date.UTC(2026, 9, 21, 12, 0, s));
    const deliver = (id, type, object, created) => {
      const { body, signature } = provider.webhook({ id, type, object, created });
      return handleBillingWebhook(pool, provider, "fake", Buffer.from(body), signature);
    };
    // Stripe sent paid (t=10), then failed (t=20); the failure arrives first.
    assert.equal((await deliver("evt_failed", "invoice.payment_failed", { customer: "cus_acme" }, t(20))).body.applied, true);
    const late = await deliver("evt_paid", "invoice.paid", { customer: "cus_acme" }, t(10));
    assert.deepEqual([late.status, late.body.applied, late.body.ignored], [200, false, "stale"]);
    assert.equal(await statusOf(pool, acme.accountId), "past_due");
    // Recorded all the same: a retry of the stale event stays a no-op.
    assert.equal((await deliver("evt_paid", "invoice.paid", { customer: "cus_acme" }, t(10))).body.duplicate, true);
    // A genuinely newer payment does clear it.
    await deliver("evt_paid_2", "invoice.paid", { customer: "cus_acme" }, t(30));
    assert.equal(await statusOf(pool, acme.accountId), "active");
  });
});

test("out of order: deleted is terminal; a late or later invoice event does not re-activate; a newer live subscription does", { skip }, async () => {
  await withSchema("billing_webhook_order_deleted", async (pool) => {
    const { acme } = await billed(pool);
    const provider = new FakeBillingProvider(SECRET);
    const t = (s) => new Date(Date.UTC(2026, 9, 21, 12, 0, s));
    const deliver = (id, type, object, created) => {
      const { body, signature } = provider.webhook({ id, type, object, created });
      return handleBillingWebhook(pool, provider, "fake", Buffer.from(body), signature);
    };
    await deliver("evt_deleted", "customer.subscription.deleted", { customer: "cus_acme", status: "canceled" }, t(20));
    assert.equal(await statusOf(pool, acme.accountId), "suspended");

    // An `active` subscription update from before the deletion, arriving after it.
    const lateActive = await deliver("evt_active_old", "customer.subscription.updated", { customer: "cus_acme", status: "active" }, t(10));
    assert.equal(lateActive.body.ignored, "stale");
    // A final invoice paid after the deletion: newer, but an invoice cannot revive a deleted subscription.
    const paid = await deliver("evt_final_invoice", "invoice.paid", { customer: "cus_acme" }, t(25));
    assert.equal(paid.body.ignored, "subscription_ended");
    assert.equal(await statusOf(pool, acme.accountId), "suspended");

    // The customer resubscribes: a newer subscription event saying it is live re-activates.
    await deliver("evt_resubscribed", "customer.subscription.created", { customer: "cus_acme", status: "active" }, t(40));
    assert.equal(await statusOf(pool, acme.accountId), "active");
    // And invoices count again after that.
    await deliver("evt_failed", "invoice.payment_failed", { customer: "cus_acme" }, t(50));
    assert.equal(await statusOf(pool, acme.accountId), "past_due");
  });
});

test("a deployment with no provider, or another provider, answers 404", { skip }, async () => {
  await withSchema("billing_webhook_none", async (pool) => {
    assert.equal((await handleBillingWebhook(pool, null, "stripe", "{}", "t=1,v1=00")).status, 404);
    assert.equal((await handleBillingWebhook(pool, new FakeBillingProvider(SECRET), "stripe", "{}", "t=1,v1=00")).status, 404);
  });
});
