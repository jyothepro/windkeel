

import type { Pool, PoolClient } from "pg";
import { conservativePrice, type ModelPrice } from "@windkeel/verification/providers/catalog.js";
import { DEFAULT_PRICING, type PricingConfig } from "../factory/config/billing.js";
import { countVerificationRuns, selectUsageRollup } from "./stores/billing-store.js";

type Queryable = Pool | PoolClient;

export interface BillingPeriod {

  start: Date;

  end: Date;
}

export class InvalidPeriodError extends Error {
  override readonly name = "InvalidPeriodError";
}

export function periodContaining(at: Date): BillingPeriod {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { start, end };
}

export function parsePeriod(value: string | undefined, now: Date = new Date()): BillingPeriod {
  if (value === undefined || value === "") return periodContaining(now);
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  if (!match) throw new InvalidPeriodError(`period must be YYYY-MM (got ${value.slice(0, 20)})`);
  return periodContaining(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)));
}

export function periodLabel(period: BillingPeriod): string {
  return period.start.toISOString().slice(0, 7);
}

export interface OrganizationUsage {
  organizationId: string;
  period: { start: string; end: string; label: string };

  raw: {

    windkeelModelUsd: number;

    customerModelUsd: number;

    sandboxUsd: number;
  };

  verification: {
    modelUsd: number;
    sandboxUsd: number;
    totalUsd: number;

    runs: number;
  };
  unpriced: {
    calls: number;

    estimatedWindkeelUsd: number;

    estimatedCustomerUsd: number;
  };
  billable: {
    aiUsd: number;
    computeFeeUsd: number;
    verificationFeeUsd: number;
    totalUsd: number;

    totalMicroUsd: number;
  };

  throughSeq: string | null;
  pricing: PricingConfig;
}

export interface UsageOptions {
  pricing?: PricingConfig;

  unpricedRate?: ModelPrice;

  recordedBefore?: Date;
}

const round = (usd: number): number => Number(usd.toFixed(9));

export async function getOrganizationUsage(
  db: Queryable,
  organizationId: string,
  period: BillingPeriod,
  options: UsageOptions = {},
): Promise<OrganizationUsage> {
  const pricing = options.pricing ?? DEFAULT_PRICING;
  const rate = options.unpricedRate ?? conservativePrice(process.env);
  const until = options.recordedBefore && options.recordedBefore < period.end ? options.recordedBefore : period.end;

  const { rows } = await selectUsageRollup(db, organizationId, period.start, until);

  let windkeelModelUsd = 0;
  let customerModelUsd = 0;
  let sandboxUsd = 0;
  let verificationModelUsd = 0;
  let verificationSandboxUsd = 0;
  let unpricedCalls = 0;
  let estimatedWindkeelUsd = 0;
  let estimatedCustomerUsd = 0;
  let throughSeq: bigint | null = null;

  for (const row of rows) {
    const usd = Number(row["usd"]);
    const customer = row["key_source"] === "customer";
    const seq = row["max_seq"] === null ? null : BigInt(row["max_seq"] as string);
    if (seq !== null && (throughSeq === null || seq > throughSeq)) throughSeq = seq;
    if (row["kind"] === "sandbox") {
      sandboxUsd += usd;
      if (row["workspace_role"] === "verifier") verificationSandboxUsd += usd;
      continue;
    }
    if (customer) customerModelUsd += usd;
    else windkeelModelUsd += usd;
    if (row["stage_type"] === "verification_run") verificationModelUsd += usd;

    const unpriced = Number(row["unpriced"]);
    if (unpriced > 0) {
      unpricedCalls += unpriced;
      const estimate = Number(row["unpriced_in"]) * rate.input + Number(row["unpriced_out"]) * rate.output;
      if (customer) estimatedCustomerUsd += estimate;
      else estimatedWindkeelUsd += estimate;
    }
  }

  const { rows: verified } = await countVerificationRuns(db, organizationId, period.start, until);
  const verificationRuns = Number(verified[0]?.["runs"] ?? 0);

  const aiUsd = windkeelModelUsd * pricing.aiMultiplier;
  const computeFeeUsd = sandboxUsd * pricing.computeMultiplier;
  const verificationFeeUsd = verificationRuns * pricing.verificationFeeUsd;
  const totalUsd = aiUsd + computeFeeUsd + verificationFeeUsd;

  return {
    organizationId,
    period: { start: period.start.toISOString(), end: period.end.toISOString(), label: periodLabel(period) },
    raw: { windkeelModelUsd: round(windkeelModelUsd), customerModelUsd: round(customerModelUsd), sandboxUsd: round(sandboxUsd) },
    verification: {
      modelUsd: round(verificationModelUsd),
      sandboxUsd: round(verificationSandboxUsd),
      totalUsd: round(verificationModelUsd + verificationSandboxUsd),
      runs: verificationRuns,
    },
    unpriced: {
      calls: unpricedCalls,
      estimatedWindkeelUsd: round(estimatedWindkeelUsd),
      estimatedCustomerUsd: round(estimatedCustomerUsd),
    },
    billable: {
      aiUsd: round(aiUsd),
      computeFeeUsd: round(computeFeeUsd),
      verificationFeeUsd: round(verificationFeeUsd),
      totalUsd: round(totalUsd),
      totalMicroUsd: Math.round(totalUsd * 1_000_000),
    },
    throughSeq: throughSeq === null ? null : throughSeq.toString(),
    pricing,
  };
}

export function budgetSpendUsd(usage: OrganizationUsage, includeCustomerKeySpend: boolean): number {
  const windkeelEstimate = usage.unpriced.estimatedWindkeelUsd * usage.pricing.aiMultiplier;
  const customer = includeCustomerKeySpend ? usage.raw.customerModelUsd + usage.unpriced.estimatedCustomerUsd : 0;
  return round(usage.billable.totalUsd + windkeelEstimate + customer);
}
