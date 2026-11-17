/**
 * #394: usage, budgets and billing on the control plane API (ADR-0037), through the real router and
 * real Postgres. Tenancy holds: a member reads their own organization's usage and no one else's;
 * only an admin changes a budget or reaches checkout and the portal; an exhausted budget or a
 * suspended account refuses a new task with a typed reason.
 */
import "./helpers.js"; // WINDKEEL_VALIDATE_RESPONSES: every API answer here is checked against the contract.
import assert from "node:assert/strict";
import { test } from "node:test";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { FakeBillingProvider } from "../dist/billing/fake.js";
import { DEFAULT_PRICING } from "../dist/factory/config/billing.js";
import { cost, createOrganization, defaultOrganization, runIn, skip, withSchema } from "./billing-fixtures.js";

const BOOTSTRAP = "billing-bootstrap-token";
const REPO_ID = "11111111-1111-1111-1111-111111111111";

const sessions = {
  async verify(jwt) {
    const [kind, subject, id, login] = jwt.split(":");
    if (kind !== "session") return null;
    return { provider: "supabase", subject, githubUserId: Number(id), githubLogin: login, displayName: login };
  },
};

function harness(pool, overrides = {}) {
  const provider = new FakeBillingProvider("whsec_api_test");
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
    billing: {
      provider,
      providerName: "fake",
      pricing: DEFAULT_PRICING,
      selfServe: "off",
      ...overrides,
    },
  };
  const auth = { token: BOOTSTRAP, subject: "operator", sessions };
  const call = (method, path, bearer = BOOTSTRAP, body, extra = {}) =>
    handleApiRequest(deps, auth, {
      method,
      path,
      query: { get: (name) => extra.query?.[name] },
      headers: { ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }), ...(extra.headers ?? {}) },
      body,
      rawBody: extra.rawBody,
    });
  return { deps, call, provider };
}

/** Mona, a Member of the default organization (and nothing else). */
async function member(call) {
  const invited = await call("POST", "/v1/invitations", BOOTSTRAP, { githubLogin: "mona", role: "member" });
  assert.equal(invited.status, 201);
  return "session:sub-mona:9919:mona";
}

test("a member reads their organization's usage; another organization's is not found", { skip }, async () => {
  await withSchema("billing_api_usage", async (pool) => {
    const { call } = harness(pool);
    const mona = await member(call);
    const { organizationId } = await defaultOrganization(pool);
    const { runId } = await runIn(pool, organizationId, REPO_ID);
    await cost(pool, runId, { usd: 1.25, keySource: "orqon" });

    const usage = await call("GET", "/v1/usage", mona);
    assert.equal(usage.status, 200);
    assert.equal(usage.body.organizationId, organizationId);
    assert.equal(usage.body.raw.windkeelModelUsd, 1.25);
    assert.equal(usage.body.billable.totalUsd, 1.25);
    assert.equal(usage.body.budget.monthlyLimitUsd, null);
    assert.equal(usage.body.plan, "internal");
    assert.ok("verification" in usage.body, "the verification line is always there");

    const other = await createOrganization(pool, "elsewhere");
    const refused = await call("GET", `/v1/orgs/${other.organizationId}/usage`, mona);
    assert.equal(refused.status, 404, "ADR-0024 §8: not even its existence");
    assert.equal((await call("GET", "/v1/usage", mona, undefined, { query: { period: "October" } })).status, 400);
  });
});

test("only an admin changes the budget, and the change records who made it", { skip }, async () => {
  await withSchema("billing_api_budget", async (pool) => {
    const { call } = harness(pool);
    const mona = await member(call);

    const denied = await call("PUT", "/v1/budget", mona, { monthlyLimitUsd: 5 });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.missing, "billing.manage");
    assert.equal((await call("GET", "/v1/budget", mona)).body.canManage, false);

    const saved = await call("PUT", "/v1/budget", BOOTSTRAP, { monthlyLimitUsd: 5, alertThresholdPct: 90 });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.monthlyLimitUsd, 5);
    assert.equal(saved.body.alertThresholdPct, 90);
    const { rows } = await pool.query("select id from principal where is_bootstrap");
    assert.equal(saved.body.updatedByPrincipalId, rows[0].id);

    const bad = await call("PUT", "/v1/budget", BOOTSTRAP, { monthlyLimitUsd: -5 });
    assert.deepEqual([bad.status, bad.body.code], [400, "invalid_budget"]);
  });
});

test("an exhausted budget and a suspended account refuse POST /v1/tasks with 402 and the reason", { skip }, async () => {
  await withSchema("billing_api_refusal", async (pool) => {
    const { call } = harness(pool);
    const task = { repositoryId: REPO_ID, title: "t", description: "- [ ] it works" };
    assert.equal((await call("POST", "/v1/tasks", BOOTSTRAP, task)).status, 202);

    await call("PUT", "/v1/budget", BOOTSTRAP, { monthlyLimitUsd: 0 });
    const exhausted = await call("POST", "/v1/tasks", BOOTSTRAP, task);
    assert.deepEqual([exhausted.status, exhausted.body.code], [402, "org_budget_exhausted"]);
    assert.match(exhausted.body.error, /monthly budget is spent/);

    await call("PUT", "/v1/budget", BOOTSTRAP, { monthlyLimitUsd: null });
    await pool.query("update billing_account set status = 'suspended'");
    const suspended = await call("POST", "/v1/tasks", BOOTSTRAP, task);
    assert.deepEqual([suspended.status, suspended.body.code], [402, "billing_suspended"]);
  });
});

test("checkout and the portal are an admin's, for a billed account, and return only to the console", { skip }, async () => {
  await withSchema("billing_api_links", async (pool) => {
    const { call, provider } = harness(pool);
    // The default account is internal: never billed, so no checkout.
    const internal = await call("POST", "/v1/billing/checkout", BOOTSTRAP, { returnUrl: "https://console.example/settings/billing" });
    assert.deepEqual([internal.status, internal.body.code], [409, "not_billed"]);

    await pool.query("update billing_account set provider = 'fake', plan = 'managed'");
    const elsewhere = await call("POST", "/v1/billing/portal", BOOTSTRAP, { returnUrl: "https://evil.example/" });
    assert.deepEqual([elsewhere.status, elsewhere.body.code], [400, "invalid_return_url"]);

    const checkout = await call("POST", "/v1/billing/checkout", BOOTSTRAP, { returnUrl: "https://console.example/settings/billing" });
    assert.equal(checkout.status, 200);
    assert.match(checkout.body.url, /^https:\/\/billing\.fake\.invalid\/checkout\/cus_fake_/);
    const portal = await call("POST", "/v1/billing/portal", BOOTSTRAP, { returnUrl: "https://console.example/settings/billing" });
    assert.match(portal.body.url, /portal/);
    assert.equal(provider.customers.size, 1, "one customer, created once");
    const { rows } = await pool.query("select provider_customer_id from billing_account");
    assert.match(rows[0].provider_customer_id, /^cus_fake_/);

    const mona = await member(call);
    assert.equal((await call("POST", "/v1/billing/portal", mona, { returnUrl: "https://console.example/x" })).status, 403);
    const view = await call("GET", "/v1/billing", mona);
    assert.deepEqual([view.body.plan, view.body.status, view.body.canManage, view.body.selfManaged], ["managed", "active", false, true]);
  });
});

test("the billing webhook route is public, signature-checked over the raw body, and idempotent", { skip }, async () => {
  await withSchema("billing_api_webhook", async (pool) => {
    const { call, provider } = harness(pool);
    await pool.query("update billing_account set provider = 'fake', plan = 'managed', provider_customer_id = 'cus_api'");
    const delivery = provider.webhook({ id: "evt_api_1", type: "invoice.payment_failed", object: { customer: "cus_api" } });
    const post = (body, signature, path = "/v1/billing/webhooks/fake") =>
      call("POST", path, null, undefined, { rawBody: body, headers: signature ? { "stripe-signature": signature } : {} });

    assert.equal((await post(delivery.body, undefined)).status, 401);
    assert.equal((await post(delivery.body, delivery.signature, "/v1/billing/webhooks/stripe")).status, 404, "not this deployment's provider");
    const applied = await post(delivery.body, delivery.signature);
    assert.deepEqual([applied.status, applied.body.applied, applied.body.status], [200, true, "past_due"]);
    assert.equal((await post(delivery.body, delivery.signature)).body.duplicate, true);
    const { rows } = await pool.query("select status from billing_account");
    assert.equal(rows[0].status, "past_due");
  });
});
