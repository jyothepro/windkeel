import { test } from "node:test";
import assert from "node:assert/strict";
import { barPercent, budgetFromForm, budgetSentence, usageLines, usd, type UsageView } from "./billing.ts";

const usage = (overrides: Partial<UsageView> = {}): UsageView => ({
  organizationId: "o1",
  period: { start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z", label: "2026-10" },
  raw: { windkeelModelUsd: 1.5, customerModelUsd: 4, sandboxUsd: 0.5 },
  verification: { modelUsd: 0.2, sandboxUsd: 0.1, totalUsd: 0.3, runs: 2 },
  unpriced: { calls: 0, estimatedWindkeelUsd: 0, estimatedCustomerUsd: 0 },
  billable: { aiUsd: 1.5, computeFeeUsd: 0.5, verificationFeeUsd: 0, totalUsd: 2, totalMicroUsd: 2_000_000 },
  budget: { monthlyLimitUsd: 10, alertThresholdPct: 80, defaultRunCapUsd: null, includeCustomerKeySpend: false, spentUsd: 2, remainingUsd: 8, exhausted: false },
  plan: "managed",
  billingStatus: "active",
  alerts: [],
  ...overrides,
});

test("dollars: cents normally, four places for the sub-cent amounts small runs cost", () => {
  assert.equal(usd(0), "$0.00");
  assert.equal(usd(12.5), "$12.50");
  assert.equal(usd(1234.567), "$1,234.57");
  assert.equal(usd(0.0015), "$0.0015");
});

test("the verification line is always there, on its own, even at zero; own-key AI is never billed", () => {
  const lines = usageLines(usage({ verification: { modelUsd: 0, sandboxUsd: 0, totalUsd: 0, runs: 0 } }));
  const verification = lines.find((l) => l.key === "verification");
  assert.ok(verification, "never folded away");
  assert.ok(verification);
  assert.equal(verification.usd, 0);
  assert.match(verification.note, /never waived/);
  assert.equal(lines.find((l) => l.key === "ai-own")?.billed, false);
  assert.equal(lines.some((l) => l.key === "unpriced"), false, "no unpriced line when there are none");
  const withUnpriced = usageLines(usage({ unpriced: { calls: 3, estimatedWindkeelUsd: 0.5, estimatedCustomerUsd: 0 } }));
  const unpriced = withUnpriced.find((l) => l.key === "unpriced")!;
  assert.equal(unpriced.label, "3 unpriced calls");
  assert.equal(unpriced.billed, false);
});

test("bars are shares of the largest line, and empty when nothing was spent", () => {
  const lines = usageLines(usage());
  assert.equal(barPercent(4, lines), 100);
  assert.equal(barPercent(1, lines), 25);
  const empty = usageLines(usage({ raw: { windkeelModelUsd: 0, customerModelUsd: 0, sandboxUsd: 0 }, verification: { modelUsd: 0, sandboxUsd: 0, totalUsd: 0, runs: 0 } }));
  assert.equal(barPercent(0, empty), 0);
});

test("the budget sentence says unlimited, what's left, or that new runs are refused", () => {
  assert.match(budgetSentence(usage()), /\$2\.00 of \$10\.00 this month — \$8\.00 left/);
  assert.match(budgetSentence(usage({ budget: { ...usage().budget, monthlyLimitUsd: null, remainingUsd: null } })), /No monthly budget/);
  assert.match(budgetSentence(usage({ budget: { ...usage().budget, spentUsd: 10, exhausted: true, remainingUsd: 0 } })), /New runs are refused/);
});

test("the budget form: blank is unlimited, a negative is refused by name, the checkbox is opt-in", () => {
  const form = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? null });
  assert.deepEqual(budgetFromForm(form({ monthlyLimitUsd: "", alertThresholdPct: "80" })), {
    ok: true,
    budget: { monthlyLimitUsd: null, defaultRunCapUsd: null, alertThresholdPct: 80, includeCustomerKeySpend: false },
  });
  const saved = budgetFromForm(form({ monthlyLimitUsd: "$250", defaultRunCapUsd: "5", alertThresholdPct: "90", includeCustomerKeySpend: "on" }));
  assert.deepEqual(saved, { ok: true, budget: { monthlyLimitUsd: 250, defaultRunCapUsd: 5, alertThresholdPct: 90, includeCustomerKeySpend: true } });
  assert.match((budgetFromForm(form({ monthlyLimitUsd: "-1" })) as { message: string }).message, /monthly budget/);
  assert.match((budgetFromForm(form({ defaultRunCapUsd: "0" })) as { message: string }).message, /default run cap/);
  assert.match((budgetFromForm(form({ alertThresholdPct: "150" })) as { message: string }).message, /1 to 100/);
});
