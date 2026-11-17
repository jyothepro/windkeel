/**
 * #431 / ADR-0040: the credit ledger against real Postgres. Grants are keyed, so the same one twice
 * grants once; debits are one per cost line; the balance is derived, never stored; the gate refuses
 * at 0 with overage off and admits up to the cap with it on; alerts fire once per threshold per
 * period; a run's receipt equals its debits; expired and last-period credits pay for nothing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { admitRun, isBillingRefusal } from "../dist/billing/admission.js";
import {
  checkCredits,
  CreditsExhaustedError,
  enableCredits,
  getCreditBalance,
  grantCredits,
  listCreditAlerts,
  parseOverageInput,
  raiseCreditAlerts,
  setOverage,
  syncCreditDebits,
} from "../dist/billing/credit-ledger.js";
import { MICRO } from "../dist/factory/config/credits.js";
import { organizationStatement, runReceipt, statementCsv } from "../dist/billing/receipt.js";
import { reportPendingUsage } from "../dist/billing/report.js";
import { FakeBillingProvider } from "../dist/billing/fake.js";
import { periodContaining } from "../dist/billing/usage.js";
import { cost, createOrganization, credential, runIn, skip, workspace, withSchema } from "./billing-fixtures.js";

const OCT = new Date("2026-10-01T00:00:00Z");
const NOV = new Date("2026-11-01T00:00:00Z");
const DEC = new Date("2026-12-01T00:00:00Z");
const NOW = new Date("2026-10-20T12:00:00Z");
const AT = new Date("2026-10-10T12:00:00Z");
const credits = (n) => n * MICRO;

async function onCredits(pool, name, since = new Date("2026-09-01T00:00:00Z")) {
  const org = await createOrganization(pool, name, { billing: { provider: "fake" } });
  await enableCredits(pool, org.accountId, since);
  return org;
}

/** What `invoice.paid` leaves behind: a plan on a subscription, which overage is billed on. */
const subscribe = (pool, accountId, plan = "starter") =>
  pool.query("update billing_account set credit_plan = $2, provider_subscription_id = $3 where account_id = $1", [accountId, plan, `sub_${accountId}`]);

const planGrant = (pool, accountId, amount, start = OCT, end = NOV, key = `plan:${accountId}:${start.toISOString()}`) =>
  grantCredits(pool, { accountId, source: "plan", product: "starter", amountMicro: credits(amount), startsAt: start, expiresAt: end, idempotencyKey: key });

const topup = (pool, accountId, amount, startsAt, expiresAt, key) =>
  grantCredits(pool, { accountId, source: "topup", product: "topup_10", amountMicro: credits(amount), startsAt, expiresAt, idempotencyKey: key });

test("a grant is keyed: the same key twice grants once", { skip }, async () => {
  await withSchema("credits_grant_once", async (pool) => {
    const acme = await onCredits(pool, "acme");
    assert.equal((await planGrant(pool, acme.accountId, 100, OCT, NOV, "evt_1")).granted, true);
    assert.equal((await planGrant(pool, acme.accountId, 100, OCT, NOV, "evt_1")).granted, false);
    assert.equal((await getCreditBalance(pool, acme.accountId, NOW)).planMicro.included, credits(100));
  });
});

test("debits: one per cost line, priced per role; the receipt equals the debits; the balance is derived", { skip }, async () => {
  await withSchema("credits_debits", async (pool) => {
    const acme = await onCredits(pool, "acme");
    await planGrant(pool, acme.accountId, 100);
    await topup(pool, acme.accountId, 50, new Date("2026-09-15T00:00:00Z"), new Date("2027-09-15T00:00:00Z"), "t1");
    const { runId } = await runIn(pool, acme.organizationId, acme.repositoryId);
    const maker = await workspace(pool, runId, "maker");
    const verifier = await workspace(pool, runId, "verifier");
    const key = await credential(pool, acme.organizationId);
    await cost(pool, runId, { kind: "sandbox", stageType: "workspace", stageId: maker, usd: 0.4, sandboxMs: 90_000 }, AT); // 3 credits
    await cost(pool, runId, { kind: "sandbox", stageType: "workspace", stageId: verifier, usd: 0.1, sandboxMs: 29_001 }, AT); // 30 s → 1 credit
    await cost(pool, runId, { usd: 0.5, keySource: "orqon", model: "openai/gpt-x", tokensIn: 1000, tokensOut: 100 }, AT); // 50
    await cost(pool, runId, { usd: 0.2, keySource: "orqon", model: "openai/gpt-x", stageType: "verification_run", tokensIn: 10, tokensOut: 5 }, AT); // 20
    await cost(pool, runId, { usd: 2, keySource: "customer", credentialId: key, model: "openai/gpt-own", tokensIn: 7, tokensOut: 3 }, AT); // 0
    await cost(pool, runId, { usd: null, keySource: "orqon", model: "mystery", tokensIn: 5, tokensOut: 5 }, AT); // unpriced: 0

    // Before the sweep: exact, from the ledger, nothing written.
    const before = await getCreditBalance(pool, acme.accountId, NOW);
    assert.deepEqual(before.planMicro, { included: credits(100), used: credits(74), left: credits(26) }, "plan credits first");
    assert.equal(before.topups[0].leftMicro, credits(50), "top-ups untouched while plan credits last");
    assert.equal(before.availableMicro, credits(76));
    assert.equal((await pool.query("select 1 from credit_debit")).rowCount, 0, "a read writes nothing");

    const receipt = await runReceipt(pool, runId);
    assert.deepEqual(
      receipt.compute.map((c) => [c.role, c.sandboxSeconds, c.credits]),
      [
        ["maker", 90, 3],
        ["verifier", 30, 1],
      ],
      "sandbox minutes × 2, verification metered like everything else",
    );
    assert.deepEqual(
      receipt.ai.map((a) => [a.role, a.model, a.keySource, a.credits, a.unpricedCalls]),
      [
        ["maker", "mystery", "orqon", 0, 1],
        ["maker", "openai/gpt-own", "customer", 0, 0],
        ["maker", "openai/gpt-x", "orqon", 50, 0],
        ["verifier", "openai/gpt-x", "orqon", 20, 0],
      ],
    );
    assert.equal(receipt.totals.credits, 74);
    assert.equal(receipt.settled, false);

    assert.equal(await syncCreditDebits(pool, acme.accountId, NOW), 6, "one debit per cost line");
    assert.equal(await syncCreditDebits(pool, acme.accountId, NOW), 0, "idempotent on the cost line");
    const { rows } = await pool.query("select coalesce(sum(amount_micro), 0)::bigint as total, count(*)::int as n from credit_debit where engineering_run_id = $1", [runId]);
    const after = await runReceipt(pool, runId);
    assert.equal(after.settled, true);
    assert.equal(after.totals.totalMicro, Number(rows[0].total), "the receipt totals equal the ledger debits");
    assert.equal(after.totals.debitedMicro, Number(rows[0].total));
    const { rows: alloc } = await pool.query("select coalesce(sum(amount_micro), 0)::bigint as total from credit_allocation");
    assert.equal(Number(alloc[0].total), credits(74), "allocated to grants, no overage");
    assert.deepEqual((await getCreditBalance(pool, acme.accountId, NOW)).planMicro, before.planMicro, "the same balance from the debits");

    // The statement: by run, repository and role, and as CSV.
    const statement = await organizationStatement(pool, acme.organizationId, periodContaining(NOW), "2026-10");
    assert.equal(statement.totals.credits, 74);
    assert.deepEqual(statement.byRole.map((r) => [r.role, r.credits]).sort(), [["maker", 53], ["verifier", 21]]);
    assert.equal(statement.byRun[0].credits, 74);
    assert.equal(statement.byRepository.length, 1);
    const csv = statementCsv(statement).trim().split("\n");
    assert.equal(csv[0], "period,run_id,repository,role,kind,model,sandbox_seconds,tokens_in,tokens_out,credits");
    const sum = csv.slice(1).reduce((s, line) => s + Number(line.split(",").at(-1)), 0);
    assert.equal(Number(sum.toFixed(6)), 74, "the CSV's credits column sums to the total");
  });
});

test("cost recorded before the account moved onto credits is never debited", { skip }, async () => {
  await withSchema("credits_since", async (pool) => {
    const acme = await onCredits(pool, "acme", new Date("2026-10-15T00:00:00Z"));
    await planGrant(pool, acme.accountId, 100);
    const { runId } = await runIn(pool, acme.organizationId, acme.repositoryId);
    await cost(pool, runId, { usd: 0.3, keySource: "orqon" }, AT);
    await cost(pool, runId, { usd: 0.1, keySource: "orqon" }, new Date("2026-10-16T00:00:00Z"));
    assert.equal((await getCreditBalance(pool, acme.accountId, NOW)).planMicro.used, credits(10));
    assert.equal(await syncCreditDebits(pool, acme.accountId, NOW), 1);
  });
});

test("the gate: refuse at 0 with overage off; with it on, admit up to the cap; out-of-credits overrun is never billed", { skip }, async () => {
  await withSchema("credits_gate", async (pool) => {
    const acme = await onCredits(pool, "acme");
    await topup(pool, acme.accountId, 1, new Date("2026-09-15T00:00:00Z"), new Date("2027-09-15T00:00:00Z"), "t1");
    assert.equal((await checkCredits(pool, acme.organizationId, NOW)).ok, true);
    const { runId } = await runIn(pool, acme.organizationId, acme.repositoryId);
    await cost(pool, runId, { usd: 0.01, keySource: "orqon" }, AT); // exactly the one credit
    const at0 = await checkCredits(pool, acme.organizationId, NOW);
    assert.deepEqual([at0.ok, at0.overage, at0.balance.availableMicro], [false, "off", 0], "at 0 is out");
    await assert.rejects(admitRun(pool, acme.organizationId, {}, NOW), (error) => {
      assert.ok(error instanceof CreditsExhaustedError);
      assert.equal(error.code, "credits_exhausted");
      assert.ok(isBillingRefusal(error));
      assert.match(error.message, /out of credits/);
      return true;
    });

    // A step already under way overruns: recorded as overage, never billed (overage was off).
    await cost(pool, runId, { usd: 0.05, keySource: "orqon" }, AT);
    const overrun = await getCreditBalance(pool, acme.accountId, NOW);
    assert.deepEqual([overrun.overage.billedMicro, overrun.overage.unbilledMicro], [0, credits(5)]);

    assert.throws(() => parseOverageInput({ enabled: true }), /cap/);
    assert.throws(() => parseOverageInput({ enabled: "yes", capCredits: 1 }), /enabled/);
    assert.throws(() => parseOverageInput({ enabled: true, capCredits: -1 }), /capCredits/);
    const ON = new Date("2026-10-15T00:00:00Z");
    const LATER = new Date("2026-10-16T00:00:00Z");
    // Overage bills on a subscription: an account with only the trial or top-ups cannot turn it on
    // (that would be free use up to any cap it chose).
    await assert.rejects(setOverage(pool, acme.accountId, { enabled: true, capCredits: 1_000_000 }, ON), /needs a plan/);
    assert.equal((await checkCredits(pool, acme.organizationId, NOW)).ok, false, "still out of credits");
    await subscribe(pool, acme.accountId);
    await setOverage(pool, acme.accountId, parseOverageInput({ enabled: true, capCredits: 3 }), ON);
    const on = await checkCredits(pool, acme.organizationId, NOW);
    assert.equal(on.ok, true, "overage on, nothing billed yet");
    assert.deepEqual([on.balance.overage.billedMicro, on.balance.overage.unbilledMicro], [0, credits(5)], "the earlier overrun stays unbilled");
    assert.deepEqual(await admitRun(pool, acme.organizationId, {}, NOW), {});

    await cost(pool, runId, { usd: 0.02, keySource: "orqon" }, LATER);
    assert.equal((await checkCredits(pool, acme.organizationId, NOW)).ok, true, "2 of 3");
    await cost(pool, runId, { usd: 0.01, keySource: "orqon" }, LATER);
    const capped = await checkCredits(pool, acme.organizationId, NOW);
    assert.deepEqual([capped.ok, capped.overage, capped.balance.overage.billedMicro], [false, "cap_reached", credits(3)], "at the cap is reached");
    await assert.rejects(admitRun(pool, acme.organizationId, {}, NOW), /overage cap/);

    // Not on credits: the gate never refuses (ADR-0037's budget is the only limit).
    const payg = await createOrganization(pool, "payg", { billing: { provider: "fake" } });
    assert.deepEqual(await checkCredits(pool, payg.organizationId, NOW), { ok: true, onCredits: false });
    await assert.rejects(setOverage(pool, payg.accountId, { enabled: true, capCredits: 1 }), /not on a credit plan/);
  });
});

test("expiry and reset: an expired top-up and last period's plan credits pay for nothing", { skip }, async () => {
  await withSchema("credits_expiry", async (pool) => {
    const acme = await onCredits(pool, "acme");
    await planGrant(pool, acme.accountId, 100, OCT, NOV, "oct");
    await planGrant(pool, acme.accountId, 10, NOV, DEC, "nov");
    await topup(pool, acme.accountId, 20, new Date("2025-11-05T00:00:00Z"), new Date("2026-11-05T00:00:00Z"), "old-topup");
    const { runId } = await runIn(pool, acme.organizationId, acme.repositoryId);
    await cost(pool, runId, { usd: 0.4, keySource: "orqon" }, AT); // 40 credits in October
    await cost(pool, runId, { usd: 0.15, keySource: "orqon" }, new Date("2026-11-10T00:00:00Z")); // 15 in November

    const november = await getCreditBalance(pool, acme.accountId, new Date("2026-11-12T00:00:00Z"));
    assert.deepEqual(november.planMicro, { included: credits(10), used: credits(10), left: 0 }, "October's 60 unused credits did not roll over");
    assert.equal(november.topups.length, 0, "the top-up expired on 2026-11-05");
    assert.deepEqual([november.overage.billedMicro, november.overage.unbilledMicro], [0, credits(5)]);
    assert.equal(november.period.start.toISOString(), NOV.toISOString());
    assert.equal(november.period.basis, "plan_grant");
    assert.equal(november.admits, false);
    // In October the same top-up was still live, and plan credits were spent first.
    const october = await getCreditBalance(pool, acme.accountId, NOW);
    assert.deepEqual([october.planMicro.left, october.topups[0].leftMicro], [credits(60), credits(20)]);
  });
});

test("alerts fire once per threshold per period: 50, 80, 100 and the overage cap", { skip }, async () => {
  await withSchema("credits_alerts", async (pool) => {
    const acme = await onCredits(pool, "acme");
    await planGrant(pool, acme.accountId, 10);
    const { runId } = await runIn(pool, acme.organizationId, acme.repositoryId);
    assert.deepEqual(await raiseCreditAlerts(pool, acme.accountId, NOW), []);
    await cost(pool, runId, { usd: 0.05, keySource: "orqon" }, AT);
    assert.deepEqual(await raiseCreditAlerts(pool, acme.accountId, NOW), ["plan_50"]);
    assert.deepEqual(await raiseCreditAlerts(pool, acme.accountId, NOW), [], "once");
    await cost(pool, runId, { usd: 0.05, keySource: "orqon" }, AT);
    assert.deepEqual(await raiseCreditAlerts(pool, acme.accountId, NOW), ["plan_80", "plan_100"]);
    await subscribe(pool, acme.accountId);
    await setOverage(pool, acme.accountId, { enabled: true, capCredits: 2 }, OCT);
    await cost(pool, runId, { usd: 0.02, keySource: "orqon" }, AT);
    assert.deepEqual(await raiseCreditAlerts(pool, acme.accountId, NOW), ["overage_cap"]);
    assert.deepEqual(await raiseCreditAlerts(pool, acme.accountId, NOW), []);
    const alerts = await listCreditAlerts(pool, acme.accountId, OCT);
    assert.deepEqual(alerts.map((a) => a.kind).sort(), ["overage_cap", "plan_100", "plan_50", "plan_80"]);

    // A new period alerts afresh.
    await planGrant(pool, acme.accountId, 10, NOV, DEC, "nov");
    await cost(pool, runId, { usd: 0.06, keySource: "orqon" }, new Date("2026-11-03T00:00:00Z"));
    assert.deepEqual(await raiseCreditAlerts(pool, acme.accountId, new Date("2026-11-04T00:00:00Z")), ["plan_50"]);
  });
});

test("the sweep debits credit accounts and meters only billed overage, in micro-USD, once", { skip }, async () => {
  await withSchema("credits_report", async (pool) => {
    const acme = await onCredits(pool, "acme");
    await planGrant(pool, acme.accountId, 1);
    await subscribe(pool, acme.accountId);
    await setOverage(pool, acme.accountId, { enabled: true, capCredits: 100 }, OCT);
    const { runId } = await runIn(pool, acme.organizationId, acme.repositoryId);
    await cost(pool, runId, { usd: 0.01, keySource: "orqon" }, AT); // covered by the plan
    const provider = new FakeBillingProvider();
    const first = await reportPendingUsage({ pool, provider, now: NOW });
    assert.equal(first.debitsWritten, 1);
    assert.equal(first.reports.filter((r) => r.organizationId === acme.organizationId).length, 0, "plan credits are prepaid: nothing metered");
    assert.deepEqual(first.creditAlerts.map((a) => a.kind).sort(), ["plan_100", "plan_50", "plan_80"]);

    await cost(pool, runId, { usd: 0.25, keySource: "orqon" }, AT); // 25 credits of overage = $0.25
    const second = await reportPendingUsage({ pool, provider, now: NOW });
    const mine = second.reports.filter((r) => r.organizationId === acme.organizationId);
    assert.deepEqual(mine.map((r) => [r.status, r.amountMicroUsd]), [["sent", 250_000]]);
    assert.equal(second.creditAlerts.length, 0, "each threshold once per period");
    const third = await reportPendingUsage({ pool, provider, now: NOW });
    assert.equal(third.reports.filter((r) => r.organizationId === acme.organizationId).length, 0, "sent once");
    assert.equal(third.creditAlerts.length, 0, "alerted once");
  });
});

test("a sandbox charge records the wall-clock time it covers; a run's compute is rounded once, not per charge (#439)", { skip }, async () => {
  const { chargeSandboxUsage } = await import("../dist/factory/workspace-service.js");
  await withSchema("credits_sandbox_ms", async (pool) => {
    const acme = await onCredits(pool, "acme");
    const live = new Date(Date.now() - 86_400_000);
    await planGrant(pool, acme.accountId, 100, live, new Date(Date.now() + 30 * 86_400_000));
    const after = () => new Date(Date.now() + 60_000);
    const { runId } = await runIn(pool, acme.organizationId, acme.repositoryId);
    const ws = await workspace(pool, runId, "verifier");
    let usage = { activeCpuMs: 10, wallClockMs: 1_500, networkEgressBytes: 0 };
    const handle = { usage: async () => usage };
    const zero = { usdPerCpuMs: 0, usdPerEgressByte: 0 };
    await chargeSandboxUsage(pool, handle, ws, runId, zero);
    usage = { activeCpuMs: 20, wallClockMs: 4_000, networkEgressBytes: 0 };
    await chargeSandboxUsage(pool, handle, ws, runId, zero);
    await chargeSandboxUsage(pool, handle, ws, runId, { usdPerCpuMs: 0.001, usdPerEgressByte: 0 });
    const { rows } = await pool.query("select sandbox_ms, usd from cost_event where stage_id = $1 order by seq", [ws]);
    assert.deepEqual(
      rows.map((r) => [Number(r.sandbox_ms), Number(r.usd)]),
      [
        [1_500, 0],
        [2_500, 0],
        [0, 0.02],
      ],
      "wall-clock deltas, never CPU time; the dollar cost stays the provider's CPU figure",
    );
    const receipt = await runReceipt(pool, runId);
    assert.deepEqual(receipt.compute.map((c) => [c.role, c.sandboxSeconds]), [["verifier", 4]], "1.5 s + 2.5 s bills 4 s, not 2 s + 3 s");
    assert.equal(receipt.totals.totalMicro, 133_333, "4 s at 2 credits a minute, rounded once");

    assert.equal(await syncCreditDebits(pool, acme.accountId, after()), 3);
    const debited = async () =>
      (
        await pool.query(
          "select coalesce(sum(sandbox_seconds), 0)::int as s, coalesce(sum(amount_micro), 0)::int as m from credit_debit where engineering_run_id = $1",
          [runId],
        )
      ).rows[0];
    assert.deepEqual(await debited(), { s: 4, m: 133_333 }, "the debits are the receipt");

    // A charge after the sweep wrote those debits still rounds with them: 4.6 s in all is 5 s.
    usage = { activeCpuMs: 20, wallClockMs: 4_600, networkEgressBytes: 0 };
    await chargeSandboxUsage(pool, handle, ws, runId, zero);
    assert.deepEqual((await runReceipt(pool, runId)).compute.map((c) => c.sandboxSeconds), [5]);
    assert.equal(await syncCreditDebits(pool, acme.accountId, after()), 1);
    assert.deepEqual(await debited(), { s: 5, m: 166_667 });
    assert.equal((await runReceipt(pool, runId)).totals.debitedMicro, 166_667);
  });
});

test("billed overage stops at the cap: the line that crosses it bills up to it, the rest is recorded unbilled (#439)", { skip }, async () => {
  await withSchema("credits_cap_clamp", async (pool) => {
    const acme = await onCredits(pool, "acme"); // 0 credits: every credit spent is overage
    await subscribe(pool, acme.accountId);
    await setOverage(pool, acme.accountId, { enabled: true, capCredits: 3 }, OCT);
    const { runId } = await runIn(pool, acme.organizationId, acme.repositoryId);
    const balance = async () => {
      const b = await getCreditBalance(pool, acme.accountId, NOW);
      return [b.overage.billedMicro, b.overage.unbilledMicro, b.availableMicro, b.admits];
    };
    assert.deepEqual(await balance(), [0, 0, 0, true], "0 credits, overage on: admitted");
    await cost(pool, runId, { usd: 0.02, keySource: "orqon" }, AT);
    assert.deepEqual(await balance(), [credits(2), 0, 0, true]);
    // The step under way when the cap is reached runs on: 5 more credits, 1 of them billable.
    await cost(pool, runId, { usd: 0.05, keySource: "orqon" }, new Date(AT.getTime() + 60_000));
    assert.deepEqual(await balance(), [credits(3), credits(4), 0, false], "billed exactly the cap, never past it");
    await cost(pool, runId, { usd: 0.01, keySource: "orqon" }, new Date(AT.getTime() + 120_000));
    assert.deepEqual(await balance(), [credits(3), credits(5), 0, false], "past the cap nothing more is billed");
    const capped = await checkCredits(pool, acme.organizationId, NOW);
    assert.deepEqual([capped.ok, capped.overage], [false, "cap_reached"]);

    const provider = new FakeBillingProvider();
    const report = await reportPendingUsage({ pool, provider, now: NOW });
    assert.equal(report.debitsWritten, 3);
    const { rows } = await pool.query(
      "select overage_micro, overage_billable_micro, overage_billable from credit_debit where account_id = $1 order by recorded_at",
      [acme.accountId],
    );
    assert.deepEqual(
      rows.map((r) => [Number(r.overage_micro), Number(r.overage_billable_micro), r.overage_billable]),
      [
        [credits(2), credits(2), true],
        [credits(5), credits(1), false],
        [credits(1), 0, false],
      ],
      "each debit says how much of its overage is billed",
    );
    assert.deepEqual(await balance(), [credits(3), credits(5), 0, false], "the same balance from the debits");
    const mine = report.reports.filter((r) => r.organizationId === acme.organizationId);
    assert.deepEqual(mine.map((r) => [r.status, r.amountMicroUsd]), [["sent", 30_000]], "the meter gets the cap ($0.03), not the $0.08 spent");
  });
});

test("a cap reached exactly bills all of it; raising the cap later never bills what ran past the old one (#439)", { skip }, async () => {
  await withSchema("credits_cap_raise", async (pool) => {
    const acme = await onCredits(pool, "acme");
    await subscribe(pool, acme.accountId);
    await setOverage(pool, acme.accountId, { enabled: true, capCredits: 2 }, OCT);
    const { runId } = await runIn(pool, acme.organizationId, acme.repositoryId);
    await cost(pool, runId, { usd: 0.02, keySource: "orqon" }, AT);
    let b = await getCreditBalance(pool, acme.accountId, NOW);
    assert.deepEqual([b.overage.billedMicro, b.overage.unbilledMicro, b.admits], [credits(2), 0, false], "exactly the cap: billed in full, and at the cap is reached");
    await cost(pool, runId, { usd: 0.04, keySource: "orqon" }, new Date(AT.getTime() + 60_000));
    // The admin raises the cap before the sweep has run: cost already recorded keeps the cap it ran under.
    await setOverage(pool, acme.accountId, { enabled: true, capCredits: 10 }, new Date("2026-10-15T00:00:00Z"));
    b = await getCreditBalance(pool, acme.accountId, NOW);
    assert.deepEqual([b.overage.billedMicro, b.overage.unbilledMicro, b.admits], [credits(2), credits(4), true]);
    await cost(pool, runId, { usd: 0.03, keySource: "orqon" }, new Date("2026-10-16T00:00:00Z"));
    b = await getCreditBalance(pool, acme.accountId, NOW);
    assert.deepEqual([b.overage.billedMicro, b.overage.unbilledMicro], [credits(5), credits(4)], "spend after the raise bills against the new cap");
  });
});

test("property, against Postgres: generated spend never bills past the cap and debits equal the read (#439)", { skip, timeout: 240_000 }, async () => {
  const fc = (await import("fast-check")).default;
  await withSchema("credits_cap_property", async (pool) => {
    let n = 0;
    const line = fc.record({ cents: fc.integer({ min: 0, max: 6 }), sandboxMs: fc.option(fc.integer({ min: 0, max: 7_000 })) });
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 8 }), fc.array(line, { minLength: 1, maxLength: 8 }), async (grant, cap, lines) => {
        n += 1;
        const org = await onCredits(pool, `p${n}`);
        if (grant > 0) await topup(pool, org.accountId, grant, new Date("2026-09-15T00:00:00Z"), new Date("2027-09-15T00:00:00Z"), `p${n}`);
        await subscribe(pool, org.accountId);
        await setOverage(pool, org.accountId, { enabled: true, capCredits: cap }, OCT);
        const { runId } = await runIn(pool, org.organizationId, org.repositoryId);
        const ws = await workspace(pool, runId, "maker");
        for (const [i, l] of lines.entries()) {
          const at = new Date(AT.getTime() + i * 1_000);
          if (l.sandboxMs === null) await cost(pool, runId, { usd: l.cents / 100, keySource: "orqon" }, at);
          else await cost(pool, runId, { kind: "sandbox", stageType: "workspace", stageId: ws, usd: 0, sandboxMs: l.sandboxMs }, at);
        }
        const read = await getCreditBalance(pool, org.accountId, NOW);
        assert.ok(read.overage.billedMicro <= credits(cap), "billed overage within the cap");
        assert.ok(read.availableMicro >= 0 && read.overage.unbilledMicro >= 0);
        await syncCreditDebits(pool, org.accountId, NOW);
        const { rows } = await pool.query(
          `select coalesce(sum(amount_micro), 0)::bigint as amount, coalesce(sum(overage_micro), 0)::bigint as overage,
                  coalesce(sum(overage_billable_micro), 0)::bigint as billed,
                  coalesce(sum(sandbox_seconds), 0)::bigint as seconds
             from credit_debit where account_id = $1`,
          [org.accountId],
        );
        const { rows: alloc } = await pool.query(
          "select coalesce(sum(a.amount_micro), 0)::bigint as allocated from credit_allocation a join credit_debit d on d.id = a.debit_id where d.account_id = $1",
          [org.accountId],
        );
        const totalMs = lines.reduce((s, l) => s + (l.sandboxMs ?? 0), 0);
        assert.equal(Number(rows[0].seconds), Math.ceil(totalMs / 1000), "the run's compute is one rounding of its total");
        assert.equal(Number(rows[0].billed), read.overage.billedMicro, "the debits bill what the read showed");
        assert.equal(Number(rows[0].overage) - Number(rows[0].billed), read.overage.unbilledMicro);
        assert.equal(Number(alloc[0].allocated) + Number(rows[0].overage), Number(rows[0].amount), "spend is conserved");
        assert.ok(Number(alloc[0].allocated) <= credits(grant), "no grant is overdrawn");
        const after = await getCreditBalance(pool, org.accountId, NOW);
        assert.deepEqual([after.overage.billedMicro, after.overage.unbilledMicro, after.availableMicro], [read.overage.billedMicro, read.overage.unbilledMicro, read.availableMicro]);
      }),
      { numRuns: 30 },
    );
  });
});
