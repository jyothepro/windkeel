/**
 * #431 / ADR-0040: the credit math, pure. 1 credit = US$0.01; compute is 2 credits a sandbox-minute
 * billed per started second; AI on Windkeel's key at cost, on the organization's own key nothing; plan
 * credits first, then top-ups oldest expiry first, then overage; plan credits reset each period,
 * top-ups expire 12 months after purchase; plans carry a bonus, packs none.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addMonths,
  allocate,
  billedSeconds,
  bonusPct,
  computeMicro,
  creditsToMicro,
  daysUntil,
  formatCredits,
  isLive,
  MICRO,
  microCreditsToMicroUsd,
  PLANS,
  priceCostLine,
  spendOrder,
  thresholdsReached,
  TOPUP_PACKS,
  TRIAL_CREDITS,
  usdToMicro,
} from "../dist/factory/config/credits.js";

const at = (iso) => new Date(iso);

test("sandbox time is billed per started second, at 2 credits a minute", () => {
  assert.equal(billedSeconds(0), 0);
  assert.equal(billedSeconds(null), 0);
  assert.equal(billedSeconds(1), 1, "1 ms is a started second");
  assert.equal(billedSeconds(1000), 1);
  assert.equal(billedSeconds(1001), 2);
  assert.equal(billedSeconds(59_999), 60);
  assert.equal(computeMicro(60), 2 * MICRO, "a minute is exactly 2 credits");
  assert.equal(computeMicro(30), 1 * MICRO, "half a minute is 1 credit");
  assert.equal(computeMicro(3), 100_000, "3 seconds is a tenth of a credit, exactly");
  assert.equal(computeMicro(1), 33_333, "one second is 1/30 credit, rounded once to the micro-credit");
  assert.equal(computeMicro(3600), 120 * MICRO, "an hour is 120 credits ($1.20)");
  // Per second, not per minute rounded up: 61 seconds is not 2 minutes.
  assert.equal(computeMicro(billedSeconds(61_000)), Math.round((61 * 2 * MICRO) / 60));
  assert.notEqual(computeMicro(61), 4 * MICRO);
});

test("AI on Windkeel's key is at cost; on the organization's key it is compute only; unpriced is never invoiced", () => {
  assert.equal(usdToMicro(1), 100 * MICRO, "US$1 is 100 credits");
  assert.equal(usdToMicro(0.01), MICRO, "US$0.01 is one credit");
  assert.deepEqual(priceCostLine({ kind: "model", usd: 0.25, keySource: "orqon", sandboxMs: null }), {
    kind: "ai",
    amountMicro: 25 * MICRO,
    sandboxSeconds: null,
    unpriced: false,
  });
  assert.equal(priceCostLine({ kind: "model", usd: 0.25, keySource: null, sandboxMs: null }).amountMicro, 25 * MICRO, "pre-0031 rows are Windkeel's");
  assert.equal(priceCostLine({ kind: "model", usd: 3, keySource: "customer", sandboxMs: null }).amountMicro, 0, "BYOK pays compute only");
  assert.deepEqual(priceCostLine({ kind: "model", usd: null, keySource: "orqon", sandboxMs: null }), {
    kind: "ai",
    amountMicro: 0,
    sandboxSeconds: null,
    unpriced: true,
  });
  // A sandbox line is priced by its time, never by its dollar figure.
  assert.deepEqual(priceCostLine({ kind: "sandbox", usd: 99, keySource: null, sandboxMs: 90_500 }), {
    kind: "compute",
    amountMicro: computeMicro(91),
    sandboxSeconds: 91,
    unpriced: false,
  });
  assert.equal(microCreditsToMicroUsd(MICRO), 10_000, "one credit is $0.01 = 10,000 micro-USD on the meter");
});

test("the plans and packs are the maintainer's, and only plans carry a bonus", () => {
  assert.deepEqual(
    Object.values(PLANS).map((p) => [p.key, p.priceUsd, p.credits, bonusPct(p)]),
    [
      ["starter", 20, 2_000, 0],
      ["pro", 50, 5_250, 5],
      ["team", 100, 11_000, 10],
      ["scale", 250, 30_000, 20],
    ],
  );
  assert.deepEqual(
    Object.values(TOPUP_PACKS).map((t) => [t.priceUsd, t.credits, bonusPct(t)]),
    [
      [10, 1_000, 0],
      [25, 2_500, 0],
      [50, 5_000, 0],
    ],
    "packs: no bonus",
  );
  assert.equal(TRIAL_CREDITS, 500);
  assert.equal(creditsToMicro(5_250), 5_250 * MICRO);
});

const grant = (id, source, startsAt, expiresAt, remaining, createdAt = startsAt) => ({
  id,
  source,
  startsAt: at(startsAt),
  expiresAt: at(expiresAt),
  createdAt: at(createdAt),
  remainingMicro: remaining,
});

test("spend order: plan credits first, then top-ups and the trial oldest expiry first, then overage", () => {
  const grants = [
    grant("topup-late", "topup", "2026-09-01", "2027-09-01", 300),
    grant("trial", "trial", "2026-05-01", "2027-05-01", 100),
    grant("plan", "plan", "2026-10-01", "2026-11-01", 200),
    grant("topup-early", "topup", "2026-06-01", "2027-06-01", 100),
    grant("upgrade", "upgrade", "2026-10-15", "2026-11-01", 50),
  ];
  assert.deepEqual(
    spendOrder(grants).map((g) => g.id),
    ["plan", "upgrade", "trial", "topup-early", "topup-late"],
  );
  const now = at("2026-10-20T00:00:00Z");
  const first = allocate(320, grants, now);
  assert.deepEqual(first, {
    allocations: [
      { grantId: "plan", amountMicro: 200 },
      { grantId: "upgrade", amountMicro: 50 },
      { grantId: "trial", amountMicro: 70 },
    ],
    overageMicro: 0,
  });
  // The array is spent in place, so the next debit continues where this one stopped.
  const second = allocate(1_000, grants, now);
  assert.deepEqual(second.allocations, [
    { grantId: "trial", amountMicro: 30 },
    { grantId: "topup-early", amountMicro: 100 },
    { grantId: "topup-late", amountMicro: 300 },
  ]);
  assert.equal(second.overageMicro, 570, "what no grant covers is overage");
  assert.deepEqual(allocate(5, grants, now), { allocations: [], overageMicro: 5 });
  assert.deepEqual(allocate(0, [grant("x", "topup", "2026-01-01", "2027-01-01", 10)], now), { allocations: [], overageMicro: 0 });
});

test("expiry: a grant spends only while live, and at its expiry instant it is gone", () => {
  const topup = grant("t", "topup", "2025-10-20T00:00:00Z", "2026-10-20T00:00:00Z", 1_000);
  assert.equal(isLive(topup, at("2026-10-19T23:59:59.999Z")), true);
  assert.equal(isLive(topup, at("2026-10-20T00:00:00Z")), false, "expiry is exclusive");
  assert.equal(isLive(topup, at("2025-10-19T00:00:00Z")), false, "not before it was bought");
  assert.deepEqual(allocate(10, [topup], at("2026-10-21T00:00:00Z")), { allocations: [], overageMicro: 10 });
  assert.equal(topup.remainingMicro, 1_000, "an expired grant is not drawn down");
  // Top-ups expire 12 months after purchase, clamped to the month's last day.
  assert.equal(addMonths(at("2026-10-27T13:45:00Z"), 12).toISOString(), "2027-10-27T13:45:00.000Z");
  assert.equal(addMonths(at("2028-02-29T00:00:00Z"), 12).toISOString(), "2029-02-28T00:00:00.000Z");
  assert.equal(addMonths(at("2026-01-31T00:00:00Z"), 1).toISOString(), "2026-02-28T00:00:00.000Z");
});

test("reset: last period's plan credits never pay for this period's work (no rollover)", () => {
  const october = grant("oct", "plan", "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z", 1_500);
  const november = grant("nov", "plan", "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z", 2_000);
  const result = allocate(2_500, [october, november], at("2026-11-02T00:00:00Z"));
  assert.deepEqual(result.allocations, [{ grantId: "nov", amountMicro: 2_000 }]);
  assert.equal(result.overageMicro, 500);
  assert.equal(october.remainingMicro, 1_500, "October's unused credits stayed in October");
  assert.equal(daysUntil(at("2026-12-01T00:00:00Z"), at("2026-11-30T23:00:00Z")), 1);
  assert.equal(daysUntil(at("2026-12-01T00:00:00Z"), at("2026-11-02T00:00:00Z")), 29);
  assert.equal(daysUntil(at("2026-12-01T00:00:00Z"), at("2026-12-02T00:00:00Z")), 0);
});

test("alert thresholds: 50, 80 and 100 percent of plan credits", () => {
  assert.deepEqual(thresholdsReached(0, 100), []);
  assert.deepEqual(thresholdsReached(49, 100), []);
  assert.deepEqual(thresholdsReached(50, 100), [50]);
  assert.deepEqual(thresholdsReached(80, 100), [50, 80]);
  assert.deepEqual(thresholdsReached(100, 100), [50, 80, 100]);
  assert.deepEqual(thresholdsReached(5, 0), [], "no plan credits, no plan alerts");
  assert.equal(formatCredits(1234.5), "1,234.50");
});
