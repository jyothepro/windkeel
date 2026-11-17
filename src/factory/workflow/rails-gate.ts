import type { Pool } from "pg";
import {
  enforceRepairLoopRails as enforceRepairLoopRailsWith,
  enforceSpendAndTimeRails as enforceSpendAndTimeRailsWith,
  type RailsGateResult,
  type SpendRailOptions,
} from "../rails-gate.js";
import type { RiskLevel } from "../rails.js";
import { enforceOrganizationBudget } from "../../billing/run-budget.js";

export {
  enforceApprovalDeadline,
  unpricedSpendEstimate,
  type OrganizationBudgetGate,
  type RailsGateResult,
  type SpendRailOptions,
} from "../rails-gate.js";
export { enforceOrganizationBudget };

export function enforceSpendAndTimeRails(
  pool: Pool,
  engineeringRunId: string,
  now: Date = new Date(),
  options: SpendRailOptions = {},
): Promise<RailsGateResult> {
  return enforceSpendAndTimeRailsWith(pool, engineeringRunId, now, { budgetGate: enforceOrganizationBudget, ...options });
}

export function enforceRepairLoopRails(pool: Pool, engineeringRunId: string, riskLevel: RiskLevel): Promise<RailsGateResult> {
  return enforceRepairLoopRailsWith(pool, engineeringRunId, riskLevel, enforceOrganizationBudget);
}
