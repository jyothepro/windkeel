/**
 * #394 / ADR-0037 §2–3: an organization's month of usage is the ledger, added up — and the
 * billable amount follows the two-plan rule: Windkeel-key AI cost and the compute fee, never the
 * organization's own-key spend, never unpriced calls, and verification always its own line.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetSpendUsd, getOrganizationUsage, parsePeriod, periodContaining } from "../dist/billing/usage.js";
import { loadPricing } from "../dist/factory/config/billing.js";
import {
  cost,
  createOrganization,
  credential,
  defaultOrganization,
  runIn,
  skip,
  verificationRun,
  withSchema,
  workspace,
} from "./billing-fixtures.js";

const OCT = parsePeriod("2026-10");
const inOct = (day, time = "12:00:00") => new Date(`2026-10-${String(day).padStart(2, "0")}T${time}Z`);
const RATE = { input: 0.00001, output: 0.00003 };

test("parsePeriod takes YYYY-MM in UTC and refuses anything else", () => {
  assert.equal(OCT.start.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(OCT.end.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(parsePeriod("2026-12").end.toISOString(), "2027-01-01T00:00:00.000Z");
  assert.throws(() => parsePeriod("2026-13"), /YYYY-MM/);
  assert.throws(() => parsePeriod("oct"), /YYYY-MM/);
  assert.deepEqual(parsePeriod(undefined, new Date("2026-02-15T00:00:00Z")), periodContaining(new Date("2026-02-01T00:00:00Z")));
});

test("pricing knobs default to pass-through and refuse a negative", () => {
  assert.deepEqual(loadPricing({}), { aiMultiplier: 1, computeMultiplier: 1, verificationFeeUsd: 0 });
  assert.deepEqual(
    loadPricing({ WINDKEEL_BILLING_AI_MULTIPLIER: "1.2", WINDKEEL_BILLING_COMPUTE_MULTIPLIER: "2", WINDKEEL_BILLING_VERIFICATION_FEE_USD: "0.5" }),
    { aiMultiplier: 1.2, computeMultiplier: 2, verificationFeeUsd: 0.5 },
  );
  assert.throws(() => loadPricing({ WINDKEEL_BILLING_COMPUTE_MULTIPLIER: "-1" }), /WINDKEEL_BILLING_COMPUTE_MULTIPLIER/);
});

test("an organization with no ledger rows used nothing", { skip }, async () => {
  await withSchema("billing_usage_empty", async (pool) => {
    const { organizationId } = await createOrganization(pool, "empty");
    const usage = await getOrganizationUsage(pool, organizationId, OCT);
    assert.equal(usage.billable.totalUsd, 0);
    assert.equal(usage.billable.totalMicroUsd, 0);
    assert.equal(usage.unpriced.calls, 0);
    assert.equal(usage.throughSeq, null);
  });
});

test("the month equals a hand-computed sum of the ledger, by the billable rule", { skip }, async () => {
  await withSchema("billing_usage_sum", async (pool) => {
    const acme = await createOrganization(pool, "acme");
    const other = await createOrganization(pool, "other");
    const { runId } = await runIn(pool, acme.organizationId, acme.repositoryId);
    const key = await credential(pool, acme.organizationId);
    const maker = await workspace(pool, runId, "maker");
    const verifier = await workspace(pool, runId, "verifier");

    await cost(pool, runId, { usd: 1.25, keySource: "orqon" }, inOct(3)); // managed AI
    await cost(pool, runId, { usd: 4, keySource: "customer", credentialId: key }, inOct(3)); // BYOK: shown, not billed
    await cost(pool, runId, { stageType: "verification_run", usd: 0.5, keySource: "orqon" }, inOct(4)); // checker
    await cost(pool, runId, { stageType: "workspace", stageId: maker, kind: "sandbox", usd: 0.3 }, inOct(4));
    await cost(pool, runId, { stageType: "workspace", stageId: verifier, kind: "sandbox", usd: 0.2 }, inOct(5));
    // Unpriced (#242): counted and estimated, never invoiced.
    await cost(pool, runId, { usd: null, tokensIn: 1000, tokensOut: 100, keySource: "orqon", model: "mystery" }, inOct(6));
    await verificationRun(pool, runId, "fail", inOct(5));
    await verificationRun(pool, runId, null, inOct(5)); // never reached a verdict: no fee

    // Noise the month must not see: another organization, the month before, the month after.
    const { runId: otherRun } = await runIn(pool, other.organizationId, other.repositoryId);
    await cost(pool, otherRun, { usd: 100, keySource: "orqon" }, inOct(3));
    await cost(pool, runId, { usd: 7, keySource: "orqon" }, new Date("2026-09-30T23:59:59.999Z"));
    await cost(pool, runId, { usd: 9, keySource: "orqon" }, new Date("2026-11-01T00:00:00.000Z"));

    const pricing = { aiMultiplier: 1.2, computeMultiplier: 2, verificationFeeUsd: 0.1 };
    const usage = await getOrganizationUsage(pool, acme.organizationId, OCT, { pricing, unpricedRate: RATE });

    assert.equal(usage.raw.windkeelModelUsd, 1.75);
    assert.equal(usage.raw.customerModelUsd, 4);
    assert.equal(usage.raw.sandboxUsd, 0.5);
    assert.deepEqual(usage.verification, { modelUsd: 0.5, sandboxUsd: 0.2, totalUsd: 0.7, runs: 1 });
    assert.equal(usage.unpriced.calls, 1);
    assert.equal(usage.unpriced.estimatedWindkeelUsd, 0.013);
    // AI 1.75 × 1.2 = 2.1; compute 0.5 × 2 = 1; one verified run × 0.1.
    assert.equal(usage.billable.aiUsd, 2.1);
    assert.equal(usage.billable.computeFeeUsd, 1);
    assert.equal(usage.billable.verificationFeeUsd, 0.1);
    assert.equal(usage.billable.totalUsd, 3.2);
    assert.equal(usage.billable.totalMicroUsd, 3_200_000);

    // The hand sum, straight from the ledger: Windkeel-key model + sandbox, nothing customer, nothing null.
    const { rows } = await pool.query(
      `select coalesce(sum(c.usd) filter (where c.kind = 'model' and c.key_source is distinct from 'customer'), 0) as ai,
              coalesce(sum(c.usd) filter (where c.kind = 'sandbox'), 0) as sandbox
         from cost_event c join engineering_run r on r.id = c.engineering_run_id join engineering_task t on t.id = r.task_id
        where t.organization_id = $1 and c.recorded_at >= $2 and c.recorded_at < $3`,
      [acme.organizationId, OCT.start, OCT.end],
    );
    assert.equal(Number(rows[0].ai), usage.raw.windkeelModelUsd);
    assert.equal(Number(rows[0].sandbox), usage.raw.sandboxUsd);

    // The ledger view agrees on the month's priced total.
    const { rows: view } = await pool.query(
      "select coalesce(sum(usd), 0) as usd, sum(unpriced_calls) as unpriced from organization_usage_month where organization_id = $1 and period_start = $2",
      [acme.organizationId, OCT.start],
    );
    assert.equal(Number(view[0].usd), 1.75 + 4 + 0.5);
    assert.equal(Number(view[0].unpriced), 1);
  });
});

test("an event at 23:59:59 UTC on the last day is that month's; midnight is the next", { skip }, async () => {
  await withSchema("billing_usage_boundary", async (pool) => {
    const acme = await createOrganization(pool, "acme");
    const { runId } = await runIn(pool, acme.organizationId, acme.repositoryId);
    await cost(pool, runId, { usd: 2, keySource: "orqon" }, new Date("2026-10-31T23:59:59Z"));
    await cost(pool, runId, { usd: 3, keySource: "orqon" }, new Date("2026-11-01T00:00:00Z"));
    assert.equal((await getOrganizationUsage(pool, acme.organizationId, OCT)).billable.totalUsd, 2);
    assert.equal((await getOrganizationUsage(pool, acme.organizationId, parsePeriod("2026-11"))).billable.totalUsd, 3);
  });
});

test("budget spend counts unpriced at the estimate, and own-key spend only when opted in", { skip }, async () => {
  await withSchema("billing_usage_budget_spend", async (pool) => {
    const acme = await createOrganization(pool, "acme");
    const { runId } = await runIn(pool, acme.organizationId, acme.repositoryId);
    const key = await credential(pool, acme.organizationId);
    await cost(pool, runId, { usd: 1, keySource: "orqon" }, inOct(2));
    await cost(pool, runId, { usd: 5, keySource: "customer", credentialId: key }, inOct(2));
    await cost(pool, runId, { usd: null, tokensIn: 100_000, tokensOut: 0, keySource: "orqon", model: "x" }, inOct(2));
    const usage = await getOrganizationUsage(pool, acme.organizationId, OCT, { unpricedRate: RATE });
    assert.equal(usage.billable.totalUsd, 1, "unpriced and own-key are not billed");
    assert.equal(budgetSpendUsd(usage, false), 2, "1 billed + 1 estimated");
    assert.equal(budgetSpendUsd(usage, true), 7, "and 5 on the organization's own key, when it opts in");
  });
});

test("the migration backfills the default account as internal and unbilled, with no budget", { skip }, async () => {
  await withSchema("billing_usage_backfill", async (pool) => {
    const { accountId, organizationId } = await defaultOrganization(pool);
    const { rows } = await pool.query("select provider, plan, status from billing_account where account_id = $1", [accountId]);
    assert.deepEqual(rows[0], { provider: "none", plan: "internal", status: "active" });
    const budgets = await pool.query("select 1 from organization_budget where organization_id = $1", [organizationId]);
    assert.equal(budgets.rowCount, 0, "no row is unlimited — today's behaviour");
    const admin = await pool.query("select permissions from access_role where key = 'admin' and account_id is null");
    assert.ok(admin.rows[0].permissions.includes("billing.manage"));
    const member = await pool.query("select permissions from access_role where key = 'member' and account_id is null");
    assert.ok(!member.rows[0].permissions.includes("billing.manage"));
  });
});
