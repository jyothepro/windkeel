import { test } from "node:test";
import assert from "node:assert/strict";
import { balanceSentence, credits, refusalSentence, roleLabel, type CreditBalanceView } from "./credits.ts";

const balance = (overrides: Partial<CreditBalanceView> = {}): CreditBalanceView => ({
  organizationId: "o1",
  onCredits: true,
  plan: "pro",
  period: { start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z", daysToReset: 5 },
  planCredits: { included: 5250, used: 250, left: 5000 },
  topups: [],
  overage: { enabled: false, capCredits: null, billedCredits: 0, unbilledCredits: 0 },
  availableCredits: 5000,
  admits: true,
  alerts: [],
  ...overrides,
});

test("credits read with two decimals and thousands separators", () => {
  assert.equal(credits(0), "0.00");
  assert.equal(credits(1234.5), "1,234.50");
});

test("the balance sentence says what is left and when the plan resets", () => {
  assert.equal(balanceSentence(balance()), "5,000.00 credits left · plan resets in 5 days");
  assert.equal(balanceSentence(balance({ onCredits: false })), "Not on a credit plan: billed by usage.");
});

test("out of credits says why runs are refused, with overage off and at its cap", () => {
  assert.equal(refusalSentence(balance()), null);
  assert.match(refusalSentence(balance({ admits: false, availableCredits: 0 }))!, /turn on overage/);
  assert.match(
    refusalSentence(balance({ admits: false, overage: { enabled: true, capCredits: 10, billedCredits: 10, unbilledCredits: 0 } }))!,
    /overage cap/,
  );
  assert.equal(roleLabel("verifier"), "Verifier");
});
