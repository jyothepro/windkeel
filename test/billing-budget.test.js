/**
 * #394 / ADR-0037 §5: per-organization monthly budgets. No row is unlimited; at the limit is
 * exhausted; the run cap never exceeds what is left; alerts are raised once per period.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkOrganizationBudget,
  effectiveRunCap,
  getBudget,
  parseBudgetInput,
  recordBudgetAlerts,
  setBudget,
} from "../dist/billing/budget.js";
import { cost, createOrganization, credential, runIn, skip, withSchema } from "./billing-fixtures.js";

const NOW = new Date("2026-10-15T12:00:00Z");
const AT = new Date("2026-10-10T12:00:00Z");

test("effectiveRunCap is the cap asked for, else the organization's default — never sized to the budget", () => {
  const none = { defaultRunCapUsd: null };
  assert.equal(effectiveRunCap(undefined, none), undefined, "no default: ADR-0011's $25 applies downstream");
  assert.equal(effectiveRunCap(10, none), 10);
  assert.equal(effectiveRunCap(undefined, { defaultRunCapUsd: 5 }), 5, "the organization's default cap seeds it");
  assert.equal(effectiveRunCap(12, { defaultRunCapUsd: 5 }), 12, "a cap the caller names wins");
  assert.equal(effectiveRunCap(null, { defaultRunCapUsd: 5 }), null, "a confirmed uncapped run stays uncapped");
});

test("parseBudgetInput takes dollars and a percentage, and refuses anything else by name", () => {
  assert.deepEqual(parseBudgetInput({ monthlyLimitUsd: 100, alertThresholdPct: 75 }), { monthlyLimitUsd: 100, alertThresholdPct: 75 });
  assert.deepEqual(parseBudgetInput({ monthlyLimitUsd: null }), { monthlyLimitUsd: null });
  assert.throws(() => parseBudgetInput({ monthlyLimitUsd: -1 }), /monthlyLimitUsd/);
  assert.throws(() => parseBudgetInput({ monthlyLimitUsd: "10" }), /monthlyLimitUsd/);
  assert.throws(() => parseBudgetInput({ defaultRunCapUsd: 0 }), /defaultRunCapUsd/);
  assert.throws(() => parseBudgetInput({ alertThresholdPct: 0 }), /alertThresholdPct/);
  assert.throws(() => parseBudgetInput({ alertThresholdPct: 50.5 }), /alertThresholdPct/);
  assert.throws(() => parseBudgetInput({ includeCustomerKeySpend: "yes" }), /includeCustomerKeySpend/);
  assert.throws(() => parseBudgetInput([]), /object/);
});

test("no row is unlimited; under, at and over the limit; a limit of 0 refuses the first run", { skip }, async () => {
  await withSchema("billing_budget_limits", async (pool) => {
    const acme = await createOrganization(pool, "acme");
    const { runId } = await runIn(pool, acme.organizationId, acme.repositoryId);
    await cost(pool, runId, { usd: 10, keySource: "orqon" }, AT);

    const unlimited = await checkOrganizationBudget(pool, acme.organizationId, NOW);
    assert.equal(unlimited.ok, true);
    assert.equal(unlimited.limitUsd, null);
    assert.equal(unlimited.remainingUsd, null);

    await setBudget(pool, acme.organizationId, { monthlyLimitUsd: 25 }, null);
    const under = await checkOrganizationBudget(pool, acme.organizationId, NOW);
    assert.deepEqual([under.ok, under.spentUsd, under.remainingUsd], [true, 10, 15]);

    await setBudget(pool, acme.organizationId, { monthlyLimitUsd: 10 }, null);
    const at = await checkOrganizationBudget(pool, acme.organizationId, NOW);
    assert.deepEqual([at.ok, at.reason, at.spentUsd, at.limitUsd], [false, "org_budget_exhausted", 10, 10], "at the limit is exhausted");

    await setBudget(pool, acme.organizationId, { monthlyLimitUsd: 4 }, null);
    assert.equal((await checkOrganizationBudget(pool, acme.organizationId, NOW)).ok, false);

    const fresh = await createOrganization(pool, "fresh");
    await setBudget(pool, fresh.organizationId, { monthlyLimitUsd: 0 }, null);
    assert.equal((await checkOrganizationBudget(pool, fresh.organizationId, NOW)).ok, false, "0 refuses even with nothing spent");

    // Last month's spend is last month's.
    assert.equal((await checkOrganizationBudget(pool, acme.organizationId, new Date("2026-11-02T00:00:00Z"))).ok, true);
  });
});

test("setBudget keeps fields it was not given and records who changed it", { skip }, async () => {
  await withSchema("billing_budget_set", async (pool) => {
    const acme = await createOrganization(pool, "acme");
    const { rows } = await pool.query("select id from principal where is_bootstrap");
    await setBudget(pool, acme.organizationId, { monthlyLimitUsd: 50, alertThresholdPct: 60, defaultRunCapUsd: 5 }, rows[0].id);
    const kept = await setBudget(pool, acme.organizationId, { includeCustomerKeySpend: true }, rows[0].id);
    assert.equal(kept.monthlyLimitUsd, 50);
    assert.equal(kept.alertThresholdPct, 60);
    assert.equal(kept.defaultRunCapUsd, 5);
    assert.equal(kept.includeCustomerKeySpend, true);
    assert.equal(kept.updatedByPrincipalId, rows[0].id);
    const cleared = await setBudget(pool, acme.organizationId, { monthlyLimitUsd: null }, null);
    assert.equal(cleared.monthlyLimitUsd, null);
    assert.equal((await getBudget(pool, acme.organizationId)).defaultRunCapUsd, 5);
  });
});

test("own-key spend counts toward the budget only when the organization opts in", { skip }, async () => {
  await withSchema("billing_budget_byok", async (pool) => {
    const acme = await createOrganization(pool, "acme");
    const { runId } = await runIn(pool, acme.organizationId, acme.repositoryId);
    const key = await credential(pool, acme.organizationId);
    await cost(pool, runId, { usd: 30, keySource: "customer", credentialId: key }, AT);
    await setBudget(pool, acme.organizationId, { monthlyLimitUsd: 20 }, null);
    assert.equal((await checkOrganizationBudget(pool, acme.organizationId, NOW)).ok, true, "BYOK spend excluded by default");
    await setBudget(pool, acme.organizationId, { includeCustomerKeySpend: true }, null);
    assert.equal((await checkOrganizationBudget(pool, acme.organizationId, NOW)).ok, false);
  });
});

test("an unpriced call counts toward enforcement at the conservative estimate", { skip }, async () => {
  await withSchema("billing_budget_unpriced", async (pool) => {
    const acme = await createOrganization(pool, "acme");
    const { runId } = await runIn(pool, acme.organizationId, acme.repositoryId);
    // Ten million tokens of a model nobody priced: a lot of money at the catalog's highest rate.
    await cost(pool, runId, { usd: null, tokensIn: 10_000_000, tokensOut: 1_000_000, keySource: "orqon", model: "mystery" }, AT);
    await setBudget(pool, acme.organizationId, { monthlyLimitUsd: 5 }, null);
    const check = await checkOrganizationBudget(pool, acme.organizationId, NOW);
    assert.equal(check.ok, false, "unknown is not zero (#242)");
    assert.ok(check.spentUsd > 5);
  });
});

test("crossing the alert threshold writes one alert per period, however often it is checked", { skip }, async () => {
  await withSchema("billing_budget_alerts", async (pool) => {
    const acme = await createOrganization(pool, "acme");
    const { runId } = await runIn(pool, acme.organizationId, acme.repositoryId);
    await setBudget(pool, acme.organizationId, { monthlyLimitUsd: 10, alertThresholdPct: 80 }, null);
    await cost(pool, runId, { usd: 5, keySource: "orqon" }, AT);
    assert.deepEqual(await recordBudgetAlerts(pool, acme.organizationId, NOW), [], "50% crosses nothing");
    await cost(pool, runId, { usd: 3.5, keySource: "orqon" }, AT);
    assert.deepEqual(await recordBudgetAlerts(pool, acme.organizationId, NOW), [80]);
    assert.deepEqual(await recordBudgetAlerts(pool, acme.organizationId, NOW), [], "idempotent within the period");
    await cost(pool, runId, { usd: 2, keySource: "orqon" }, AT);
    assert.deepEqual(await recordBudgetAlerts(pool, acme.organizationId, NOW), [100]);
    const { rows } = await pool.query("select threshold_pct from budget_alert where organization_id = $1 order by 1", [acme.organizationId]);
    assert.deepEqual(rows.map((r) => r.threshold_pct), [80, 100]);
    // A new month starts clean.
    await cost(pool, runId, { usd: 9, keySource: "orqon" }, new Date("2026-11-03T00:00:00Z"));
    assert.deepEqual(await recordBudgetAlerts(pool, acme.organizationId, new Date("2026-11-04T00:00:00Z")), [80]);
  });
});
