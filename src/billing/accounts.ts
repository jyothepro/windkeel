

import type { Pool, PoolClient } from "pg";
import type { BillingProviderName } from "../factory/config/billing.js";
import type { BillingProvider, BillingStatus } from "./provider.js";
import {
  lockBillingStatusByCustomer,
  selectBillingAccount,
  selectBillingAccountForOrganization,
  setBillingCustomerIfUnset,
  updateBillingStatus,
} from "./stores/billing-store.js";

type Queryable = Pool | PoolClient;

export type BillingPlan = "internal" | "byok" | "managed";

export interface BillingAccount {
  accountId: string;
  provider: BillingProviderName;
  providerCustomerId: string | null;
  plan: BillingPlan;
  status: BillingStatus;
  statusReason: string | null;
  trialCreditUsd: number;
  updatedAt: Date;
}

function rowToAccount(row: Record<string, unknown>): BillingAccount {
  return {
    accountId: row["account_id"] as string,
    provider: row["provider"] as BillingProviderName,
    providerCustomerId: (row["provider_customer_id"] as string | null) ?? null,
    plan: row["plan"] as BillingPlan,
    status: row["status"] as BillingStatus,
    statusReason: (row["status_reason"] as string | null) ?? null,
    trialCreditUsd: Number(row["trial_credit_usd"]),
    updatedAt: row["updated_at"] as Date,
  };
}

async function getBillingAccount(db: Queryable, accountId: string): Promise<BillingAccount | null> {
  const { rows } = await selectBillingAccount(db, accountId);
  return rows[0] ? rowToAccount(rows[0]) : null;
}

export async function billingAccountForOrganization(
  db: Queryable,
  organizationId: string,
): Promise<{ accountId: string; accountName: string; billing: BillingAccount | null } | null> {
  const { rows } = await selectBillingAccountForOrganization(db, organizationId);
  const row = rows[0];
  if (!row) return null;
  return {
    accountId: row["org_account_id"] as string,
    accountName: row["account_name"] as string,
    billing: row["provider"] ? rowToAccount({ ...row, account_id: row["org_account_id"] }) : null,
  };
}

export async function ensureBillingCustomer(
  db: Queryable,
  provider: BillingProvider,
  account: { accountId: string; accountName: string; billing: BillingAccount },
): Promise<string> {
  if (account.billing.providerCustomerId) return account.billing.providerCustomerId;
  const { customerId } = await provider.ensureCustomer({ accountId: account.accountId, name: account.accountName });

  await setBillingCustomerIfUnset(db, account.accountId, customerId);
  const stored = await getBillingAccount(db, account.accountId);
  return stored?.providerCustomerId ?? customerId;
}

export interface AppliedBillingEvent {

  accountId: string | null;
  applied: boolean;

  ignored?: "stale" | "subscription_ended";
}

export async function applyBillingEvent(
  db: Queryable,
  where: { provider: string; customerId: string },
  event: { status: BillingStatus; source: "invoice" | "subscription"; ended: boolean; at: Date; reason: string },
): Promise<AppliedBillingEvent> {
  const { rows } = await lockBillingStatusByCustomer(db, where.provider, where.customerId);
  const row = rows[0];
  if (!row) return { accountId: null, applied: false };
  const accountId = row["account_id"] as string;
  const last = row["status_event_at"] as Date | null;
  if (last && event.at.getTime() < last.getTime()) return { accountId, applied: false, ignored: "stale" };
  if (row["subscription_ended"] === true && event.source === "invoice") {
    return { accountId, applied: false, ignored: "subscription_ended" };
  }
  await updateBillingStatus(db, accountId, event.status, event.reason, event.at, event.source === "subscription", event.ended);
  return { accountId, applied: true };
}
