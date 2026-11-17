

import type { Pool } from "pg";
import type { Log } from "../factory/stage-wiring.js";
import { withSweepLock, type LockOutcome } from "../factory/sweeps/advisory-lock.js";
import { ensureBillingCustomer, type BillingAccount } from "./accounts.js";
import { recordBudgetAlerts } from "./budget.js";
import { DEFAULT_PRICING, type PricingConfig } from "../factory/config/billing.js";
import { listCreditAccounts, raiseCreditAlerts, syncCreditDebits, type CreditAlertKind } from "./credit-ledger.js";
import { microCreditsToMicroUsd } from "../factory/config/credits.js";
import { BillingProviderError, type BillingProvider } from "./provider.js";
import {
  insertUsageReport,
  markUsageReportFailed,
  markUsageReportSent,
  selectBilledOrganizations,
  selectBilledOverage,
  selectReportedUsage,
  selectUnsentUsageReports,
} from "./stores/billing-store.js";
import { getOrganizationUsage, periodContaining, periodLabel, type BillingPeriod } from "./usage.js";

const USAGE_REPORT_SWEEP = "billing-usage-report";
const DEFAULT_REPORT_HORIZON_MS = 60_000;

export interface ReportDeps {
  pool: Pool;
  provider: BillingProvider;
  now?: Date;
  pricing?: PricingConfig;
  horizonMs?: number;
  log?: Log;
}

export interface ReportOutcome {
  organizationId: string;
  period: string;
  idempotencyKey: string;
  amountMicroUsd: number;
  status: "sent" | "failed";

  retry: boolean;
}

export interface ReportResult {
  reports: ReportOutcome[];

  unchanged: number;
  alerts: Array<{ organizationId: string; thresholdPct: number }>;

  creditAlerts: Array<{ accountId: string; kind: CreditAlertKind }>;
  debitsWritten: number;
}

interface Billed {
  organizationId: string;
  accountId: string;
  accountName: string;
  billing: BillingAccount;

  creditSince: Date | null;
}

export async function reportPendingUsage(deps: ReportDeps): Promise<ReportResult> {
  const now = deps.now ?? new Date();
  const pricing = deps.pricing ?? DEFAULT_PRICING;
  const horizon = new Date(now.getTime() - (deps.horizonMs ?? DEFAULT_REPORT_HORIZON_MS));
  const log = deps.log ?? (() => {});
  const result: ReportResult = { reports: [], unchanged: 0, alerts: [], creditAlerts: [], debitsWritten: 0 };

  for (const accountId of await listCreditAccounts(deps.pool)) {
    try {
      result.debitsWritten += await syncCreditDebits(deps.pool, accountId, now);
      for (const kind of await raiseCreditAlerts(deps.pool, accountId, now)) {
        result.creditAlerts.push({ accountId, kind });
        log("credit alert", { accountId, kind });
      }
    } catch (error) {
      log("credit debits failed", { accountId, reason: error instanceof Error ? error.name : "unknown" });
    }
  }

  const { rows } = await selectBilledOrganizations(deps.pool, deps.provider.name);

  const current = periodContaining(horizon);
  const previous = periodContaining(new Date(current.start.getTime() - 1));
  for (const row of rows) {
    const billed: Billed = {
      organizationId: row["organization_id"] as string,
      accountId: row["account_id"] as string,
      accountName: row["account_name"] as string,
      billing: {
        accountId: row["account_id"] as string,
        provider: row["provider"],
        providerCustomerId: (row["provider_customer_id"] as string | null) ?? null,
        plan: row["plan"],
        status: row["status"],
        statusReason: (row["status_reason"] as string | null) ?? null,
        trialCreditUsd: Number(row["trial_credit_usd"]),
        updatedAt: row["updated_at"] as Date,
      },
      creditSince: (row["credit_billing_since"] as Date | null) ?? null,
    };
    for (const period of [previous, current]) {
      try {
        const outcomes = await reportOne(deps, billed, period, { now, horizon, pricing });
        if (outcomes.length === 0) result.unchanged += 1;
        result.reports.push(...outcomes);
      } catch (error) {

        log("usage report failed", {
          organizationId: billed.organizationId,
          period: periodLabel(period),
          reason: error instanceof Error ? error.name : "unknown",
        });
      }
    }
    for (const thresholdPct of await recordBudgetAlerts(deps.pool, billed.organizationId, now, { pricing })) {
      result.alerts.push({ organizationId: billed.organizationId, thresholdPct });
      log("budget alert", { organizationId: billed.organizationId, thresholdPct });
    }
  }
  return result;
}

async function reportOne(
  deps: ReportDeps,
  billed: Billed,
  period: BillingPeriod,
  at: { now: Date; horizon: Date; pricing: PricingConfig },
): Promise<ReportOutcome[]> {
  const { pool, provider } = deps;
  const label = periodLabel(period);
  const outcomes: ReportOutcome[] = [];

  const { rows: unsent } = await selectUnsentUsageReports(pool, billed.organizationId, period.start);
  for (const row of unsent) {
    const outcome = await send(deps, billed, period, row, true);
    outcomes.push(outcome);

    if (outcome.status === "failed") return outcomes;
  }

  const usage = await meteredTotal(pool, billed, period, at);
  const { rows: reported } = await selectReportedUsage(pool, billed.organizationId, period.start);
  const already = Number(reported[0]?.["cumulative"] ?? 0);
  const delta = usage.totalMicroUsd - already;
  if (delta <= 0 || usage.throughSeq === null) return outcomes;
  const lastThrough = reported[0]?.["through"] === null || reported[0]?.["through"] === undefined ? null : BigInt(reported[0]["through"]);
  if (lastThrough !== null && BigInt(usage.throughSeq) <= lastThrough) {

    return outcomes;
  }

  const idempotencyKey = `${billed.organizationId}:${label}:${usage.throughSeq}`;
  const { rows: inserted } = await insertUsageReport(pool, {
    accountId: billed.accountId,
    organizationId: billed.organizationId,
    periodStart: period.start,
    periodEnd: period.end,
    billableMicroUsd: delta,
    cumulativeMicroUsd: usage.totalMicroUsd,
    unpricedCalls: usage.unpricedCalls,
    throughSeq: usage.throughSeq,
    idempotencyKey,
    provider: provider.name,
  });

  if (!inserted[0]) return outcomes;
  outcomes.push(await send(deps, billed, period, inserted[0], false));
  return outcomes;
}

async function meteredTotal(
  pool: Pool,
  billed: Billed,
  period: BillingPeriod,
  at: { horizon: Date; pricing: PricingConfig },
): Promise<{ totalMicroUsd: number; throughSeq: string | null; unpricedCalls: number }> {
  const since = billed.creditSince;
  const paygUntil = since && since < at.horizon ? since : at.horizon;
  let payg = { totalMicroUsd: 0, throughSeq: null as string | null, unpricedCalls: 0 };
  if (paygUntil > period.start) {
    const usage = await getOrganizationUsage(pool, billed.organizationId, period, { pricing: at.pricing, recordedBefore: paygUntil });
    payg = { totalMicroUsd: usage.billable.totalMicroUsd, throughSeq: usage.throughSeq, unpricedCalls: usage.unpriced.calls };
  }
  if (!since) return payg;
  const until = at.horizon < period.end ? at.horizon : period.end;
  const { rows } = await selectBilledOverage(pool, billed.organizationId, period.start, until);
  const overageMicroUsd = microCreditsToMicroUsd(Number(rows[0]?.["overage"] ?? 0));
  const through = rows[0]?.["through"] === null || rows[0]?.["through"] === undefined ? null : String(rows[0]["through"]);
  const throughSeq =
    through === null ? payg.throughSeq : payg.throughSeq === null ? through : BigInt(through) > BigInt(payg.throughSeq) ? through : payg.throughSeq;
  return { totalMicroUsd: payg.totalMicroUsd + overageMicroUsd, throughSeq, unpricedCalls: payg.unpricedCalls };
}

async function send(
  deps: ReportDeps,
  billed: Billed,
  period: BillingPeriod,
  row: Record<string, unknown>,
  retry: boolean,
): Promise<ReportOutcome> {
  const id = row["id"] as string;
  const amountMicroUsd = Number(row["billable_micro_usd"]);
  const idempotencyKey = row["idempotency_key"] as string;
  const base = { organizationId: billed.organizationId, period: periodLabel(period), idempotencyKey, amountMicroUsd, retry };
  try {
    const customerId = await ensureBillingCustomer(deps.pool, deps.provider, billed);
    billed.billing.providerCustomerId = customerId;

    const now = deps.now ?? new Date();
    const timestamp = now < period.end ? now : new Date(period.end.getTime() - 1000);
    const { ref } = await deps.provider.reportUsage({
      customerId,
      organizationId: billed.organizationId,
      periodStart: period.start,
      periodEnd: period.end,
      amountMicroUsd,
      idempotencyKey,
      timestamp,
    });
    await markUsageReportSent(deps.pool, id, ref);
    return { ...base, status: "sent" };
  } catch (error) {
    const reason = error instanceof BillingProviderError ? error.message : "the provider call failed";
    await markUsageReportFailed(deps.pool, id, reason);
    return { ...base, status: "failed" };
  }
}

export async function reportPendingUsageLocked(deps: ReportDeps): Promise<LockOutcome<ReportResult>> {
  return withSweepLock(deps.pool, USAGE_REPORT_SWEEP, () => reportPendingUsage(deps));
}
