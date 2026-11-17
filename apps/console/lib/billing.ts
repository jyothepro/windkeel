export interface UsageView {
  organizationId: string;
  period: { start: string; end: string; label: string };
  raw: { windkeelModelUsd: number; customerModelUsd: number; sandboxUsd: number };
  verification: { modelUsd: number; sandboxUsd: number; totalUsd: number; runs: number };
  unpriced: { calls: number; estimatedWindkeelUsd: number; estimatedCustomerUsd: number };
  billable: { aiUsd: number; computeFeeUsd: number; verificationFeeUsd: number; totalUsd: number; totalMicroUsd: number };
  budget: {
    monthlyLimitUsd: number | null;
    alertThresholdPct: number;
    defaultRunCapUsd: number | null;
    includeCustomerKeySpend: boolean;
    spentUsd: number;
    remainingUsd: number | null;
    exhausted: boolean;
  };
  plan: "internal" | "byok" | "managed" | null;
  billingStatus: "active" | "past_due" | "suspended" | null;
  alerts: Array<{ thresholdPct: number; spentUsd: number; limitUsd: number; sentAt: string }>;
}

export interface BudgetView {
  monthlyLimitUsd: number | null;
  alertThresholdPct: number;
  defaultRunCapUsd: number | null;
  includeCustomerKeySpend: boolean;
  canManage?: boolean;
}

export interface BillingView {
  provider: "none" | "fake" | "stripe";
  plan: UsageView["plan"];
  status: UsageView["billingStatus"];
  statusReason: string | null;
  hasCustomer: boolean;
  selfManaged: boolean;
  canManage: boolean;
}

export function usd(value: number): string {
  if (value !== 0 && Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export interface UsageLine {
  key: "ai-windkeel" | "ai-own" | "compute" | "verification" | "unpriced";
  label: string;
  usd: number;
  note: string;
  billed: boolean;
}

export function usageLines(usage: UsageView): UsageLine[] {
  const lines: UsageLine[] = [
    { key: "ai-windkeel", label: "AI, Windkeel's models", usd: usage.raw.windkeelModelUsd, note: "AI cost", billed: true },
    { key: "ai-own", label: "AI, your own model keys", usd: usage.raw.customerModelUsd, note: "your provider bills you; never billed here", billed: false },
    { key: "compute", label: "Compute (sandboxes)", usd: usage.raw.sandboxUsd, note: "compute fee", billed: true },
    {
      key: "verification",
      label: "Verification",
      usd: usage.verification.totalUsd,
      note: `${usage.verification.runs} verification${usage.verification.runs === 1 ? "" : "s"}; included in the lines above, and never waived`,
      billed: true,
    },
  ];
  if (usage.unpriced.calls > 0) {
    lines.push({
      key: "unpriced",
      label: `${usage.unpriced.calls} unpriced call${usage.unpriced.calls === 1 ? "" : "s"}`,
      usd: usage.unpriced.estimatedWindkeelUsd + usage.unpriced.estimatedCustomerUsd,
      note: "estimate; counted toward the budget, not billed",
      billed: false,
    });
  }
  return lines;
}

export function barPercent(value: number, lines: readonly UsageLine[]): number {
  const max = Math.max(0, ...lines.map((l) => l.usd));
  return max <= 0 ? 0 : Math.round((Math.max(0, value) / max) * 100);
}

export const PLAN_LABEL: Record<NonNullable<UsageView["plan"]>, string> = {
  internal: "Internal — not billed",
  byok: "BYOK — your model keys; you pay the compute fee, plus AI cost for any role left on Windkeel's models",
  managed: "Managed — Windkeel's models; you pay AI cost and the compute fee",
};

export function budgetSentence(usage: UsageView): string {
  const { budget } = usage;
  if (budget.monthlyLimitUsd === null) return `No monthly budget: ${usd(budget.spentUsd)} counted this month.`;
  if (budget.exhausted) {
    return `Spent: ${usd(budget.spentUsd)} of ${usd(budget.monthlyLimitUsd)}. New runs are refused until the budget is raised or the month ends.`;
  }
  return `${usd(budget.spentUsd)} of ${usd(budget.monthlyLimitUsd)} this month — ${usd(budget.remainingUsd ?? 0)} left.`;
}

export function budgetFromForm(form: { get(name: string): unknown }): { ok: true; budget: Required<Omit<BudgetView, "canManage">> } | { ok: false; message: string } {
  const amount = (name: string, label: string, positive: boolean): number | null | string => {
    const raw = String(form.get(name) ?? "").trim().replace(/^\$/, "");
    if (raw === "") return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || (positive && value === 0)) {
      return `${label} must be ${positive ? "more than" : "at least"} $0, or blank.`;
    }
    return value;
  };
  const limit = amount("monthlyLimitUsd", "The monthly budget", false);
  if (typeof limit === "string") return { ok: false, message: limit };
  const cap = amount("defaultRunCapUsd", "The default run cap", true);
  if (typeof cap === "string") return { ok: false, message: cap };
  const pct = Number(String(form.get("alertThresholdPct") ?? "80").trim() || "80");
  if (!Number.isInteger(pct) || pct < 1 || pct > 100) return { ok: false, message: "The alert threshold is a whole percentage from 1 to 100." };
  return {
    ok: true,
    budget: {
      monthlyLimitUsd: limit,
      defaultRunCapUsd: cap,
      alertThresholdPct: pct,
      includeCustomerKeySpend: form.get("includeCustomerKeySpend") === "on",
    },
  };
}
