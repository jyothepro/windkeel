/**
 * #431 / ADR-0040 end to end with the fake billing provider, through the real `/v1` router, the
 * real webhook handler, the real sweep and real Postgres:
 *
 *   subscribe → run → debit → alert → top-up → overage
 *
 * plus the webhook rules on their own: the same event twice grants once (and so do two events for
 * one invoice); a proration invoice grants nothing; an upgrade grants the difference at once; a
 * downgrade waits for the next period's invoice; and the CLI renders the balance and the receipt.
 */
import "./helpers.js"; // WINDKEEL_VALIDATE_RESPONSES: every API answer here is checked against the contract.
import assert from "node:assert/strict";
import { test } from "node:test";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { DEFAULT_PRICING } from "../dist/factory/config/billing.js";
import { FakeBillingProvider } from "../dist/billing/fake.js";
import { reportPendingUsage } from "../dist/billing/report.js";
import { formatBalance, formatReceipt } from "../packages/cli/dist/commands/billing.js";
import { cost, defaultOrganization, runIn, skip, workspace, withSchema } from "./billing-fixtures.js";

const BOOTSTRAP = "credit-flow-bootstrap";
const REPO_ID = "11111111-1111-1111-1111-111111111111";
const SECRET = "whsec_credit_flow";
const DAY = 86_400;

const sessions = {
  async verify(jwt) {
    const [kind, subject, id, login] = jwt.split(":");
    return kind === "session" ? { provider: "supabase", subject, githubUserId: Number(id), githubLogin: login, displayName: login } : null;
  },
};

function harness(pool) {
  const provider = new FakeBillingProvider(SECRET);
  const deps = {
    pool,
    control: {
      approve: async () => ({ outcome: "signalled" }),
      cancel: async () => ({ outcome: "cancelled" }),
      message: async () => ({ outcome: "queued" }),
      listMessages: async () => [],
      enqueue: async () => ({ enqueued: true }),
    },
    githubUsers: { lookup: async (login) => ({ mona: { id: 9919, login: "mona" } })[login] ?? null },
    consoleUrl: "https://console.example",
    billing: { provider, providerName: "fake", pricing: DEFAULT_PRICING, selfServe: "off" },
  };
  const auth = { token: BOOTSTRAP, subject: "operator", sessions };
  const call = (method, path, bearer = BOOTSTRAP, body, query = {}) =>
    handleApiRequest(deps, auth, {
      method,
      path,
      query: { get: (name) => query[name] },
      headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
      body,
    });
  const deliver = async (id, type, object) => {
    const { body, signature } = provider.webhook({ id, type, object });
    const result = await handleApiRequest(deps, auth, {
      method: "POST",
      path: "/v1/billing/webhooks/fake",
      query: { get: () => undefined },
      headers: { "stripe-signature": signature },
      body: JSON.parse(body),
      rawBody: Buffer.from(body),
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result;
  };
  return { deps, call, deliver, provider };
}

const now = () => Math.floor(Date.now() / 1000);
const invoice = (id, customer, price, start, end, reason = "subscription_cycle") => ({
  id,
  customer,
  subscription: "sub_1",
  billing_reason: reason,
  lines: { data: [{ price: { id: price }, period: { start, end } }] },
});
const subscription = (customer, price, status = "active", start = now() - DAY, end = now() + 29 * DAY) => ({
  id: "sub_1",
  customer,
  status,
  current_period_start: start,
  current_period_end: end,
  items: { data: [{ id: "si_1", price: { id: price } }] },
});

const tasks = (call) => call("POST", "/v1/tasks", BOOTSTRAP, { repositoryId: REPO_ID, title: "t", description: "- [ ] it works" });

test("subscribe → run → debit → alert → top-up → overage, with the fake provider", { skip, timeout: 120_000 }, async () => {
  await withSchema("credit_flow", async (pool) => {
    const { call, deliver, provider } = harness(pool);
    const { organizationId, accountId } = await defaultOrganization(pool);
    await pool.query("update billing_account set provider = 'fake', plan = 'managed' where account_id = $1", [accountId]);
    assert.equal((await call("GET", "/v1/billing/balance")).body.onCredits, false, "pay-as-you-go until it subscribes");

    // Subscribe: a plan checkout on the provider's pages, then its webhooks.
    const checkout = await call("POST", "/v1/billing/checkout", BOOTSTRAP, { plan: "starter", returnUrl: "https://console.example/settings/billing" });
    assert.equal(checkout.status, 200);
    assert.match(checkout.body.url, /plan=starter/);
    const asked = provider.calls.find((c) => c.method === "checkoutUrl").input;
    assert.deepEqual(asked.purchase, { kind: "plan", plan: "starter", priceId: "price_fake_starter" });
    assert.equal((await call("POST", "/v1/billing/checkout", BOOTSTRAP, { plan: "gold", returnUrl: "https://console.example/x" })).status, 400);
    const { rows: customer } = await pool.query("select provider_customer_id from billing_account where account_id = $1", [accountId]);
    const cus = customer[0].provider_customer_id;

    await deliver("evt_cs", "checkout.session.completed", { id: "cs_sub", customer: cus, mode: "subscription", subscription: "sub_1" });
    await deliver("evt_sub", "customer.subscription.created", subscription(cus, "price_fake_starter"));
    const start = now() - DAY;
    const end = now() + 29 * DAY;
    const paid = await deliver("evt_inv", "invoice.paid", invoice("in_1", cus, "price_fake_starter", start, end, "subscription_create"));
    assert.deepEqual(paid.body.credits, { effect: "plan_granted", grantedCredits: 2000, plan: "starter" });
    // Webhook idempotency: the same event twice, and a second event for the same invoice, grant once.
    assert.equal((await deliver("evt_inv", "invoice.paid", invoice("in_1", cus, "price_fake_starter", start, end, "subscription_create"))).body.duplicate, true);
    await deliver("evt_inv_ok", "invoice.payment_succeeded", invoice("in_1", cus, "price_fake_starter", start, end, "subscription_create"));
    assert.equal((await pool.query("select 1 from credit_grant where account_id = $1", [accountId])).rowCount, 1, "granted once");

    let balance = (await call("GET", "/v1/billing/balance")).body;
    assert.deepEqual([balance.onCredits, balance.plan, balance.planCredits.included, balance.planCredits.left], [true, "starter", 2000, 2000]);
    assert.ok(balance.period.daysToReset === 29 || balance.period.daysToReset === 30, `${balance.period.daysToReset}`);
    assert.equal(balance.overage.enabled, false);
    const again = await call("POST", "/v1/billing/checkout", BOOTSTRAP, { plan: "pro", returnUrl: "https://console.example/settings/billing" });
    assert.deepEqual([again.status, again.body.code], [409, "already_subscribed"], "a plan changes; it is not bought twice");

    // Run: admitted, and its cost lines debited.
    assert.equal((await tasks(call)).status, 202);
    const { runId } = await runIn(pool, organizationId, REPO_ID);
    const maker = await workspace(pool, runId, "maker");
    const verifier = await workspace(pool, runId, "verifier");
    await cost(pool, runId, { kind: "sandbox", stageType: "workspace", stageId: maker, usd: 0.5, sandboxMs: 50 * 60_000 }); // 100 credits
    await cost(pool, runId, { kind: "sandbox", stageType: "workspace", stageId: verifier, usd: 0.1, sandboxMs: 10 * 60_000 }); // 20
    await cost(pool, runId, { usd: 10, keySource: "orqon", model: "openai/gpt-x", tokensIn: 1_000_000, tokensOut: 100_000 }); // 1000
    const sweepAt = () => new Date(Date.now() + 120_000);
    let sweep = await reportPendingUsage({ pool, provider, now: sweepAt() });
    assert.equal(sweep.debitsWritten, 3);
    assert.deepEqual(sweep.creditAlerts.map((a) => a.kind), ["plan_50"], "56% of plan credits: the 50% alert, once");
    const receipt = (await call("GET", `/v1/runs/${runId}/receipt`)).body;
    assert.equal(receipt.totals.credits, 1120);
    assert.equal(receipt.settled, true);
    assert.deepEqual(receipt.compute.map((c) => [c.role, c.sandboxMinutes, c.credits]), [["maker", 50, 100], ["verifier", 10, 20]]);
    const { rows: debited } = await pool.query("select sum(amount_micro)::bigint as micro from credit_debit where engineering_run_id = $1", [runId]);
    assert.equal(receipt.totals.credits * 1_000_000, Number(debited[0].micro), "the receipt is the debits");
    assert.deepEqual((await call("GET", `/v1/runs/${runId}`)).body.receipt.totals, receipt.totals, "the run page carries the same receipt");
    const printed = formatReceipt(receipt);
    assert.match(printed, /compute  maker\s+50\.00 min × 2\s+100\.00/);
    assert.match(printed, /total\s+1,120\.00/);

    // Out of plan credits: a hard stop — and the 80% and 100% alerts.
    await cost(pool, runId, { usd: 9, keySource: "orqon", model: "openai/gpt-x" }); // 900 → 2,020 of 2,000
    const refused = await tasks(call);
    assert.deepEqual([refused.status, refused.body.code], [402, "credits_exhausted"]);
    sweep = await reportPendingUsage({ pool, provider, now: sweepAt() });
    assert.deepEqual(sweep.creditAlerts.map((a) => a.kind).sort(), ["plan_100", "plan_80"]);
    assert.equal(sweep.reports.filter((r) => r.organizationId === organizationId).length, 0, "the overrun with overage off is never billed");

    // Top-up: a one-time payment, granted on its webhook, once.
    const topupLink = await call("POST", "/v1/billing/checkout", BOOTSTRAP, { topup: 10, returnUrl: "https://console.example/settings/billing" });
    assert.match(topupLink.body.url, /topup=topup_10/);
    const session = { id: "cs_topup", customer: cus, mode: "payment", payment_status: "paid", metadata: { windkeel_topup: "topup_10" } };
    assert.deepEqual((await deliver("evt_topup", "checkout.session.completed", session)).body.credits, { effect: "topup_granted", grantedCredits: 1000 });
    assert.equal((await deliver("evt_topup_again", "checkout.session.completed", session)).body.credits, undefined, "the same session grants once");
    await deliver("evt_unpaid", "checkout.session.completed", { ...session, id: "cs_unpaid", payment_status: "unpaid" });
    balance = (await call("GET", "/v1/billing/balance")).body;
    assert.deepEqual(balance.topups.map((t) => [t.source, t.credits, t.left]), [["topup", 1000, 1000]]);
    assert.equal(new Date(balance.topups[0].expiresAt).getUTCFullYear(), new Date().getUTCFullYear() + 1, "expires in 12 months");
    assert.equal(balance.overage.unbilledCredits, 20);
    assert.equal((await tasks(call)).status, 202, "credits again: admitted");

    // Spend the top-up, then turn on overage with a cap — an admin's to do.
    await cost(pool, runId, { usd: 10.5, keySource: "orqon", model: "openai/gpt-x" }); // 1,050: 50 past the top-up
    assert.equal((await tasks(call)).status, 402);
    const invited = await call("POST", "/v1/invitations", BOOTSTRAP, { githubLogin: "mona", role: "member" });
    assert.equal(invited.status, 201);
    const mona = "session:sub-mona:9919:mona";
    assert.equal((await call("PUT", "/v1/billing/overage", mona, { enabled: true, capCredits: 100 })).status, 403);
    assert.equal((await call("GET", "/v1/billing/balance", mona)).status, 200, "a member reads the balance");
    assert.equal((await call("PUT", "/v1/billing/overage", BOOTSTRAP, { enabled: true })).status, 400, "on needs a cap");
    const on = await call("PUT", "/v1/billing/overage", BOOTSTRAP, { enabled: true, capCredits: 100 });
    assert.deepEqual([on.status, on.body.overage.enabled, on.body.overage.capCredits, on.body.overage.billedCredits], [200, true, 100, 0]);
    assert.equal((await tasks(call)).status, 202, "overage on and under its cap");
    await new Promise((r) => setTimeout(r, 20));
    await cost(pool, runId, { usd: 1, keySource: "orqon", model: "openai/gpt-x" }); // 100 credits of billed overage
    const capped = await tasks(call);
    assert.deepEqual([capped.status, capped.body.code], [402, "credits_exhausted"]);
    assert.match(capped.body.error, /overage cap/);

    // Overage goes to the meter, in micro-USD, once; and the cap alert fires once.
    sweep = await reportPendingUsage({ pool, provider, now: sweepAt() });
    assert.deepEqual(
      sweep.reports.filter((r) => r.organizationId === organizationId).map((r) => [r.status, r.amountMicroUsd]),
      [["sent", 1_000_000]],
      "100 credits = $1.00 = 1,000,000 micro-USD",
    );
    assert.deepEqual(sweep.creditAlerts.map((a) => a.kind), ["overage_cap"]);
    sweep = await reportPendingUsage({ pool, provider, now: sweepAt() });
    assert.equal(sweep.reports.filter((r) => r.organizationId === organizationId).length, 0);
    assert.equal(sweep.creditAlerts.length, 0);
    assert.equal(provider.totalFor(cus), 1_000_000);

    balance = (await call("GET", "/v1/billing/balance")).body;
    assert.deepEqual([balance.availableCredits, balance.overage.billedCredits, balance.overage.unbilledCredits, balance.admits], [0, 100, 70, false]);
    assert.deepEqual(balance.alerts.map((a) => a.kind).sort(), ["overage_cap", "plan_100", "plan_50", "plan_80"]);
    const text = formatBalance(balance);
    assert.match(text, /Plan credits\s+0\.00 left of 2,000\.00/);
    assert.match(text, /Overage\s+on, 100\.00 of 100\.00 cap/);
    assert.match(text, /new runs are refused/);

    // The statement, as JSON and as the CSV export.
    const statement = await call("GET", "/v1/billing/statement");
    assert.equal(statement.body.totals.credits, 1120 + 900 + 1050 + 100);
    const csv = await call("GET", "/v1/billing/statement", BOOTSTRAP, undefined, { format: "csv" });
    assert.match(csv.headers["content-type"], /text\/csv/);
    assert.match(csv.raw.split("\n")[0], /^period,run_id,repository,role,kind,model/);
    assert.equal((await call("GET", "/v1/billing/statement", BOOTSTRAP, undefined, { format: "xml" })).status, 400);
  });
});

test("plan changes: an upgrade grants the difference now, a downgrade waits for the next period", { skip, timeout: 120_000 }, async () => {
  await withSchema("credit_flow_plans", async (pool) => {
    const { call, deliver, provider } = harness(pool);
    const { accountId } = await defaultOrganization(pool);
    await pool.query("update billing_account set provider = 'fake', plan = 'managed', provider_customer_id = 'cus_p' where account_id = $1", [accountId]);
    assert.equal((await call("POST", "/v1/billing/plan", BOOTSTRAP, { plan: "pro" })).status, 409, "no subscription yet");

    const start = now() - DAY;
    const end = now() + 29 * DAY;
    await deliver("e1", "invoice.paid", invoice("in_1", "cus_p", "price_fake_pro", start, end, "subscription_create"));
    const grants = async () =>
      (await pool.query("select source, product, amount_micro / 1000000 as credits from credit_grant where account_id = $1 order by created_at", [accountId])).rows.map(
        (r) => [r.source, r.product, Number(r.credits)],
      );
    assert.deepEqual(await grants(), [["plan", "pro", 5250]]);

    // Upgrade to Team: the provider is asked to prorate now; its webhook grants the difference.
    const up = await call("POST", "/v1/billing/plan", BOOTSTRAP, { plan: "team" });
    assert.deepEqual([up.status, up.body.effective, up.body.from], [202, "now", "pro"]);
    assert.deepEqual(provider.planChanges.at(-1), {
      subscriptionId: "sub_1",
      priceId: "price_fake_team",
      planPriceIds: ["price_fake_starter", "price_fake_pro", "price_fake_team", "price_fake_scale"],
      when: "now",
    });
    const upgraded = await deliver("e2", "customer.subscription.updated", subscription("cus_p", "price_fake_team", "active", start, end));
    assert.deepEqual(upgraded.body.credits, { effect: "upgrade_granted", grantedCredits: 5750, plan: "team" });
    // The proration invoice that follows grants nothing: the difference is already granted.
    await deliver("e3", "invoice.paid", invoice("in_prorate", "cus_p", "price_fake_team", now(), end, "subscription_update"));
    assert.deepEqual(await grants(), [["plan", "pro", 5250], ["upgrade", "team", 5750]]);
    const balance = (await call("GET", "/v1/billing/balance")).body;
    assert.deepEqual([balance.plan, balance.planCredits.included], ["team", 11000], "Team's credits for the rest of the period");

    // Downgrade to Starter: at period end.
    const down = await call("POST", "/v1/billing/plan", BOOTSTRAP, { plan: "starter" });
    assert.deepEqual([down.status, down.body.effective], [202, "period_end"]);
    assert.equal(provider.planChanges.at(-1).when, "period_end");
    await deliver("e4", "customer.subscription.updated", subscription("cus_p", "price_fake_starter", "active", start, end));
    let row = (await pool.query("select credit_plan, pending_credit_plan from billing_account where account_id = $1", [accountId])).rows[0];
    assert.deepEqual([row.credit_plan, row.pending_credit_plan], ["team", "starter"], "still Team until the period ends");
    assert.equal((await call("GET", "/v1/billing/balance")).body.planCredits.included, 11000);
    // The next period's invoice is the first at Starter's price: it applies the downgrade.
    await deliver("e5", "invoice.paid", invoice("in_2", "cus_p", "price_fake_starter", end, end + 30 * DAY));
    row = (await pool.query("select credit_plan, pending_credit_plan from billing_account where account_id = $1", [accountId])).rows[0];
    assert.deepEqual([row.credit_plan, row.pending_credit_plan], ["starter", null]);
    assert.deepEqual((await grants()).at(-1), ["plan", "starter", 2000]);

    // Ended: no plan from now on; credits already paid for stay until they expire.
    await deliver("e6", "customer.subscription.deleted", { ...subscription("cus_p", "price_fake_starter", "canceled"), customer: "cus_p" });
    row = (await pool.query("select credit_plan, status from billing_account where account_id = $1", [accountId])).rows[0];
    assert.deepEqual([row.credit_plan, row.status], [null, "suspended"]);
  });
});

test("a plan or pack whose price the deployment did not set cannot be bought, by name", { skip }, async () => {
  await withSchema("credit_flow_unpriced", async (pool) => {
    const { deps, call } = harness(pool);
    const { accountId } = await defaultOrganization(pool);
    await pool.query("update billing_account set provider = 'fake', plan = 'managed' where account_id = $1", [accountId]);
    deps.billing.prices = { plans: { starter: undefined, pro: "p", team: "t", scale: "s" }, topups: { topup_10: "a", topup_25: undefined, topup_50: "c" } };
    const plan = await call("POST", "/v1/billing/checkout", BOOTSTRAP, { plan: "starter", returnUrl: "https://console.example/x" });
    assert.deepEqual([plan.status, plan.body.code], [503, "price_unset"]);
    assert.match(plan.body.error, /STRIPE_PRICE_STARTER/);
    const pack = await call("POST", "/v1/billing/checkout", BOOTSTRAP, { topup: 25, returnUrl: "https://console.example/x" });
    assert.match(pack.body.error, /STRIPE_PRICE_TOPUP_25/);
    assert.equal((await call("POST", "/v1/billing/checkout", BOOTSTRAP, { topup: 7, returnUrl: "https://console.example/x" })).status, 400);
    const catalog = (await call("GET", "/v1/billing/balance")).body.catalog;
    assert.deepEqual(catalog.plans.map((p) => [p.key, p.purchasable]), [["starter", false], ["pro", true], ["team", true], ["scale", true]]);
  });
});

test("concurrent deliveries grant once and concurrent sweeps debit once; overage needs a subscription", { skip, timeout: 120_000 }, async () => {
  await withSchema("credit_flow_concurrent", async (pool) => {
    const { call, deliver } = harness(pool);
    const { accountId, organizationId } = await defaultOrganization(pool);
    await pool.query("update billing_account set provider = 'fake', plan = 'managed', provider_customer_id = 'cus_c' where account_id = $1", [accountId]);

    // A top-up alone is no subscription: overage would have nothing to bill on, so it stays off.
    const pack = { id: "cs_1", customer: "cus_c", mode: "payment", payment_status: "paid", metadata: { windkeel_topup: "topup_10" } };
    await Promise.all([deliver("t1", "checkout.session.completed", pack), deliver("t1", "checkout.session.completed", pack)]);
    const refused = await call("PUT", "/v1/billing/overage", BOOTSTRAP, { enabled: true, capCredits: 1_000_000 });
    assert.deepEqual([refused.status, refused.body.code], [409, "not_on_credits"]);
    assert.match(refused.body.error, /needs a plan/);

    // The same event twice at once, and a second event for the same invoice at once: one grant.
    const paid = invoice("in_c", "cus_c", "price_fake_starter", now() - DAY, now() + 29 * DAY, "subscription_create");
    const results = await Promise.all([
      deliver("p1", "invoice.paid", paid),
      deliver("p1", "invoice.paid", paid),
      deliver("p2", "invoice.payment_succeeded", paid),
    ]);
    assert.equal(results.filter((r) => r.body.credits?.effect === "plan_granted").length, 1);
    const { rows: grants } = await pool.query("select source, amount_micro from credit_grant where account_id = $1 order by source", [accountId]);
    assert.deepEqual(grants.map((g) => [g.source, Number(g.amount_micro)]), [["plan", 2_000_000_000], ["topup", 1_000_000_000]]);

    // Two sweeps at once write each cost line once, and never spend a grant twice.
    const { runId } = await runIn(pool, organizationId, REPO_ID);
    for (let i = 0; i < 5; i += 1) await cost(pool, runId, { usd: 1, keySource: "orqon" }, new Date());
    const later = new Date(Date.now() + 60_000);
    const sweep = () => reportPendingUsage({ pool, provider: new FakeBillingProvider(), now: later });
    const sweeps = await Promise.all([sweep(), sweep()]);
    assert.equal(sweeps[0].debitsWritten + sweeps[1].debitsWritten, 5);
    const { rows: spent } = await pool.query(
      `select (select count(*)::int from credit_debit where engineering_run_id = $1) as debits,
              (select coalesce(sum(a.amount_micro), 0)::bigint from credit_allocation a
                 join credit_grant g on g.id = a.grant_id where g.account_id = $2) as allocated`,
      [runId, accountId],
    );
    assert.deepEqual([spent[0].debits, Number(spent[0].allocated)], [5, 500_000_000], "5 × 100 credits, once");

    // On a plan, overage can go on; when the subscription ends it goes off with it.
    assert.equal((await call("PUT", "/v1/billing/overage", BOOTSTRAP, { enabled: true, capCredits: 100 })).status, 200);
    await deliver("d1", "customer.subscription.deleted", { ...subscription("cus_c", "price_fake_starter", "canceled"), customer: "cus_c" });
    const row = (await pool.query("select overage_enabled, overage_enabled_at from billing_account where account_id = $1", [accountId])).rows[0];
    assert.deepEqual([row.overage_enabled, row.overage_enabled_at], [false, null]);
  });
});
