import type { Pool } from "pg";
import { selectUnpricedModelUsage } from "./stores/cost-store.js";
import {
  checkApprovalDeadline,
  checkCaps,
  checkRepairLoop,
  parkedSeconds,
  terminalStateFor,
  type RiskLevel,
  type StopReason,
} from "./rails.js";
import {
  getEngineeringRun,
  getLastTransitionInto,
  listRepairPackets,
  listRunStateTransitions,
} from "./repositories.js";
import { advanceRun } from "./run-service.js";
import { conservativePrice, type ModelPrice } from "@windkeel/verification/providers/catalog.js";

export interface RailsGateResult {
  stopped: boolean;
  reason: StopReason | null;
}

export interface SpendRailOptions {
  unpricedRate?: ModelPrice;
  organizationBudget?: boolean;
  budgetGate?: OrganizationBudgetGate;
}

export type OrganizationBudgetGate = (pool: Pool, engineeringRunId: string, now?: Date) => Promise<RailsGateResult>;

function requireBudgetGate(gate: OrganizationBudgetGate | undefined): OrganizationBudgetGate {
  if (!gate) throw new Error("the organization-budget rail needs a budget gate (src/factory/workflow/rails-gate.ts binds billing's)");
  return gate;
}

export async function unpricedSpendEstimate(
  pool: Pool,
  engineeringRunId: string,
  rate: ModelPrice = conservativePrice(process.env),
): Promise<{ usd: number; models: string[] }> {
  const rows = await selectUnpricedModelUsage(pool, engineeringRunId);
  let usd = 0;
  const models: string[] = [];
  for (const row of rows) {
    const estimate = Number(row["tokens_in"]) * rate.input + Number(row["tokens_out"]) * rate.output;
    if (estimate <= 0) continue;
    usd += estimate;
    models.push((row["model"] as string | null) ?? "(model not recorded)");
  }
  return { usd, models };
}

export async function enforceSpendAndTimeRails(
  pool: Pool,
  engineeringRunId: string,
  now: Date = new Date(),
  options: SpendRailOptions = {},
): Promise<RailsGateResult> {
  const run = await getEngineeringRun(pool, engineeringRunId);
  if (!run) throw new Error(`engineering_run ${engineeringRunId} not found`);
  if (run.startedAt === null) return { stopped: false, reason: null };

  const rate = options.unpricedRate ?? conservativePrice(process.env);
  const estimate = await unpricedSpendEstimate(pool, engineeringRunId, rate);
  const reason = checkCaps(
    {
      rails: { spend_cap_usd: run.spendCapUsd, wall_clock_cap_seconds: run.wallClockCapSeconds },
      cost: run.cost + estimate.usd,
      started_at: run.startedAt,
      parked_seconds: parkedSeconds(await listRunStateTransitions(pool, engineeringRunId), now),
    },
    now,
  );
  if (reason === null) {
    return options.organizationBudget
      ? requireBudgetGate(options.budgetGate)(pool, engineeringRunId, now)
      : { stopped: false, reason: null };
  }

  const text =
    reason === "spend_cap" && estimate.usd > 0
      ? `spend_cap: $${run.cost.toFixed(4)} recorded + $${estimate.usd.toFixed(4)} estimated, ` +
        `model ${estimate.models.join(", ")} is unpriced — its tokens counted at the conservative ` +
        `$${perMillion(rate.input)}/$${perMillion(rate.output)} per million in/out (#324)`
      : reason;
  await advanceRun(pool, engineeringRunId, terminalStateFor(reason), text, { stopReason: reason });
  return { stopped: true, reason };
}

const perMillion = (perToken: number): string => String(Number((perToken * 1_000_000).toFixed(4)));

export async function enforceRepairLoopRails(
  pool: Pool,
  engineeringRunId: string,
  riskLevel: RiskLevel,
  budgetGate: OrganizationBudgetGate,
): Promise<RailsGateResult> {
  const packets = await listRepairPackets(pool, engineeringRunId);
  const reason = checkRepairLoop(packets, riskLevel);
  if (reason === null) return requireBudgetGate(budgetGate)(pool, engineeringRunId);

  await advanceRun(pool, engineeringRunId, terminalStateFor(reason), reason, { stopReason: reason });
  return { stopped: true, reason };
}

export async function enforceApprovalDeadline(
  pool: Pool,
  engineeringRunId: string,
  deadlineSeconds: number,
  now: Date = new Date(),
): Promise<RailsGateResult & { waitingSince: Date | null }> {
  const parked = await getLastTransitionInto(pool, engineeringRunId, "WAITING_FOR_APPROVAL");
  if (!parked) return { stopped: false, reason: null, waitingSince: null };

  const reason = checkApprovalDeadline(parked.at, now, deadlineSeconds);
  if (reason === null) return { stopped: false, reason: null, waitingSince: parked.at };

  await advanceRun(pool, engineeringRunId, terminalStateFor(reason), reason, { stopReason: reason });
  return { stopped: true, reason, waitingSince: parked.at };
}
