import type { Pool, PoolClient } from "pg";
import type { PricingConfig } from "../factory/config/billing.js";
import { budgetSpendUsd, getOrganizationUsage, periodContaining, type BillingPeriod } from "./usage.js";
import { insertBudgetAlert, selectBudgetAlerts, selectOrganizationBudget, upsertOrganizationBudget } from "./stores/billing-store.js";

type Queryable = Pool | PoolClient;

export interface OrganizationBudget {
  organizationId: string;
  monthlyLimitUsd: number | null;
  alertThresholdPct: number;
  defaultRunCapUsd: number | null;
  includeCustomerKeySpend: boolean;
  updatedByPrincipalId: string | null;
  updatedAt: Date | null;
}

export class BudgetError extends Error {
  override readonly name = "BudgetError";
}

export class OrganizationBudgetExhaustedError extends Error {
  override readonly name = "OrganizationBudgetExhaustedError";
  readonly code = "org_budget_exhausted";
  constructor(
    readonly organizationId: string,
    readonly spentUsd: number,
    readonly limitUsd: number,
  ) {
    super(
      `this organization's monthly budget is spent ($${spentUsd.toFixed(2)} of $${limitUsd.toFixed(2)}), so no new run ` +
        "starts until an admin raises it or the month ends (Settings → Billing)",
    );
  }
}

export class BillingAccountSuspendedError extends Error {
  override readonly name = "BillingAccountSuspendedError";
  readonly code = "billing_suspended";
  constructor(readonly organizationId: string) {
    super("this organization's billing account is suspended, so no new run starts until billing is resolved (Settings → Billing)");
  }
}

const UNLIMITED = (organizationId: string): OrganizationBudget => ({
  organizationId,
  monthlyLimitUsd: null,
  alertThresholdPct: 80,
  defaultRunCapUsd: null,
  includeCustomerKeySpend: false,
  updatedByPrincipalId: null,
  updatedAt: null,
});

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

export async function getBudget(db: Queryable, organizationId: string): Promise<OrganizationBudget> {
  const { rows } = await selectOrganizationBudget(db, organizationId);
  const row = rows[0];
  if (!row) return UNLIMITED(organizationId);
  return {
    organizationId,
    monthlyLimitUsd: num(row["monthly_limit_usd"]),
    alertThresholdPct: Number(row["alert_threshold_pct"]),
    defaultRunCapUsd: num(row["default_run_cap_usd"]),
    includeCustomerKeySpend: Boolean(row["include_customer_key_spend"]),
    updatedByPrincipalId: (row["updated_by_principal_id"] as string | null) ?? null,
    updatedAt: row["updated_at"] as Date,
  };
}

export interface BudgetInput {
  monthlyLimitUsd?: number | null;
  alertThresholdPct?: number;
  defaultRunCapUsd?: number | null;
  includeCustomerKeySpend?: boolean;
}

export function parseBudgetInput(body: unknown): BudgetInput {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new BudgetError("a JSON object is required");
  const input = body as Record<string, unknown>;
  const out: BudgetInput = {};
  const usd = (field: string, positive: boolean): number | null | undefined => {
    if (!(field in input)) return undefined;
    const value = input[field];
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (positive && value === 0)) {
      throw new BudgetError(`${field} must be ${positive ? "a positive" : "a non-negative"} number of US dollars, or null`);
    }
    return value;
  };
  const limit = usd("monthlyLimitUsd", false);
  if (limit !== undefined) out.monthlyLimitUsd = limit;
  const cap = usd("defaultRunCapUsd", true);
  if (cap !== undefined) out.defaultRunCapUsd = cap;
  if ("alertThresholdPct" in input) {
    const pct = input["alertThresholdPct"];
    if (typeof pct !== "number" || !Number.isInteger(pct) || pct < 1 || pct > 100) {
      throw new BudgetError("alertThresholdPct must be a whole number from 1 to 100");
    }
    out.alertThresholdPct = pct;
  }
  if ("includeCustomerKeySpend" in input) {
    if (typeof input["includeCustomerKeySpend"] !== "boolean") throw new BudgetError("includeCustomerKeySpend must be true or false");
    out.includeCustomerKeySpend = input["includeCustomerKeySpend"];
  }
  return out;
}

export async function setBudget(
  db: Queryable,
  organizationId: string,
  input: BudgetInput,
  updatedByPrincipalId: string | null,
): Promise<OrganizationBudget> {
  const current = await getBudget(db, organizationId);
  const next = {
    monthlyLimitUsd: input.monthlyLimitUsd !== undefined ? input.monthlyLimitUsd : current.monthlyLimitUsd,
    alertThresholdPct: input.alertThresholdPct ?? current.alertThresholdPct,
    defaultRunCapUsd: input.defaultRunCapUsd !== undefined ? input.defaultRunCapUsd : current.defaultRunCapUsd,
    includeCustomerKeySpend: input.includeCustomerKeySpend ?? current.includeCustomerKeySpend,
  };
  await upsertOrganizationBudget(db, organizationId, next, updatedByPrincipalId);
  return getBudget(db, organizationId);
}

export type BudgetCheck =
  | { ok: true; limitUsd: number | null; spentUsd: number; remainingUsd: number | null; budget: OrganizationBudget }
  | { ok: false; reason: "org_budget_exhausted"; spentUsd: number; limitUsd: number; budget: OrganizationBudget };

export interface BudgetCheckOptions {
  pricing?: PricingConfig;
  period?: BillingPeriod;
}

export async function checkOrganizationBudget(
  db: Queryable,
  organizationId: string,
  now: Date = new Date(),
  options: BudgetCheckOptions = {},
): Promise<BudgetCheck> {
  const budget = await getBudget(db, organizationId);
  if (budget.monthlyLimitUsd === null) {
    return { ok: true, limitUsd: null, spentUsd: 0, remainingUsd: null, budget };
  }
  const usage = await getOrganizationUsage(db, organizationId, options.period ?? periodContaining(now), {
    ...(options.pricing ? { pricing: options.pricing } : {}),
  });
  const spentUsd = budgetSpendUsd(usage, budget.includeCustomerKeySpend);
  const limitUsd = budget.monthlyLimitUsd;
  if (spentUsd >= limitUsd) return { ok: false, reason: "org_budget_exhausted", spentUsd, limitUsd, budget };
  return { ok: true, limitUsd, spentUsd, remainingUsd: Number((limitUsd - spentUsd).toFixed(9)), budget };
}

export function effectiveRunCap(
  requestedCapUsd: number | null | undefined,
  budget: Pick<OrganizationBudget, "defaultRunCapUsd">,
): number | null | undefined {
  if (requestedCapUsd !== undefined) return requestedCapUsd;
  return budget.defaultRunCapUsd ?? undefined;
}

export async function recordBudgetAlerts(
  db: Queryable,
  organizationId: string,
  now: Date = new Date(),
  options: BudgetCheckOptions = {},
): Promise<number[]> {
  const budget = await getBudget(db, organizationId);
  if (budget.monthlyLimitUsd === null) return [];
  const period = options.period ?? periodContaining(now);
  const usage = await getOrganizationUsage(db, organizationId, period, {
    ...(options.pricing ? { pricing: options.pricing } : {}),
  });
  const spent = budgetSpendUsd(usage, budget.includeCustomerKeySpend);
  const limit = budget.monthlyLimitUsd;
  const crossed = [...new Set([budget.alertThresholdPct, 100])].filter((pct) =>
    limit === 0 ? true : spent >= (limit * pct) / 100,
  );
  const raised: number[] = [];
  for (const pct of crossed) {
    const result = await insertBudgetAlert(db, organizationId, period.start, pct, spent, limit);
    if (result.rowCount === 1) raised.push(pct);
  }
  return raised;
}

export async function listBudgetAlerts(
  db: Queryable,
  organizationId: string,
  period: BillingPeriod,
): Promise<Array<{ thresholdPct: number; spentUsd: number; limitUsd: number; sentAt: Date }>> {
  const { rows } = await selectBudgetAlerts(db, organizationId, period.start);
  return rows.map((r) => ({
    thresholdPct: Number(r["threshold_pct"]),
    spentUsd: Number(r["spent_usd"]),
    limitUsd: Number(r["limit_usd"]),
    sentAt: r["sent_at"] as Date,
  }));
}
