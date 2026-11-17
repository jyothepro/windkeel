import type { Pool } from "pg";
import type { RailsGateResult } from "../factory/rails-gate.js";
import { terminalStateFor } from "../factory/rails.js";
import { advanceRun } from "../factory/run-service.js";
import { selectRunOrganizationId } from "../factory/stores/run-store.js";
import { checkOrganizationBudget } from "./budget.js";
import { pricingOrDefault } from "./admission.js";
import { checkCredits } from "./credit-ledger.js";

export async function enforceOrganizationBudget(
  pool: Pool,
  engineeringRunId: string,
  now: Date = new Date(),
): Promise<RailsGateResult> {
  const organizationId = await selectRunOrganizationId(pool, engineeringRunId);
  if (!organizationId) return { stopped: false, reason: null };
  const credits = await checkCredits(pool, organizationId, now);
  if (!credits.ok) {
    const text =
      `org_budget: the organization is out of credits${credits.overage === "cap_reached" ? " and at its overage cap" : ""}, ` +
      "so no further maker turn starts. Nothing this run made went out unverified.";
    await advanceRun(pool, engineeringRunId, terminalStateFor("org_budget"), text, { stopReason: "org_budget" });
    return { stopped: true, reason: "org_budget" };
  }
  const check = await checkOrganizationBudget(pool, organizationId, now, { pricing: pricingOrDefault() });
  if (check.ok) return { stopped: false, reason: null };
  const text =
    `org_budget: the organization's monthly budget is spent ($${check.spentUsd.toFixed(2)} of ` +
    `$${check.limitUsd.toFixed(2)}), so no further maker turn starts. Nothing this run made went out unverified.`;
  await advanceRun(pool, engineeringRunId, terminalStateFor("org_budget"), text, { stopReason: "org_budget" });
  return { stopped: true, reason: "org_budget" };
}
