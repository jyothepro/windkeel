import type { Pool, PoolClient } from "pg";
import { BillingConfigError, DEFAULT_PRICING, loadPricing, type PricingConfig } from "../factory/config/billing.js";
import {
  BillingAccountSuspendedError,
  checkOrganizationBudget,
  effectiveRunCap,
  OrganizationBudgetExhaustedError,
} from "./budget.js";
import { checkCredits, CreditsExhaustedError } from "./credit-ledger.js";
import { selectBillingStatusOfOrganization } from "./stores/billing-store.js";

type Queryable = Pool | PoolClient;

export interface AdmittedRails {
  spendCapUsd?: number | null;
  wallClockCapSeconds?: number;
  uncappedConfirmed?: boolean;
}

export function pricingOrDefault(env: NodeJS.ProcessEnv = process.env): PricingConfig {
  try {
    return loadPricing(env);
  } catch (error) {
    if (error instanceof BillingConfigError) return DEFAULT_PRICING;
    throw error;
  }
}

async function billingStatusOf(db: Queryable, organizationId: string): Promise<string | null> {
  const { rows } = await selectBillingStatusOfOrganization(db, organizationId);
  return (rows[0]?.["status"] as string | undefined) ?? null;
}

export async function admitRun<R extends AdmittedRails>(
  db: Queryable,
  organizationId: string,
  rails: R,
  now: Date = new Date(),
): Promise<R> {
  if ((await billingStatusOf(db, organizationId)) === "suspended") {
    throw new BillingAccountSuspendedError(organizationId);
  }
  const credits = await checkCredits(db, organizationId, now);
  if (!credits.ok) throw new CreditsExhaustedError(organizationId, credits.overage);
  const check = await checkOrganizationBudget(db, organizationId, now, { pricing: pricingOrDefault() });
  if (!check.ok) throw new OrganizationBudgetExhaustedError(organizationId, check.spentUsd, check.limitUsd);
  const cap = effectiveRunCap(rails.spendCapUsd, check.budget);
  return cap === undefined || cap === rails.spendCapUsd ? rails : { ...rails, spendCapUsd: cap };
}

export type BillingRefusal = OrganizationBudgetExhaustedError | BillingAccountSuspendedError | CreditsExhaustedError;

export function isBillingRefusal(error: unknown): error is BillingRefusal {
  return (
    error instanceof OrganizationBudgetExhaustedError ||
    error instanceof BillingAccountSuspendedError ||
    error instanceof CreditsExhaustedError
  );
}

export { BillingAccountSuspendedError, CreditsExhaustedError, OrganizationBudgetExhaustedError };
