

import type { PoolClient } from "pg";
import { productForPrice, type CreditPrices } from "../factory/config/billing.js";
import { enableCredits, grantCredits, topupWindow } from "./credit-ledger.js";
import { creditsToMicro, isTopupKey, PLANS, TOPUP_PACKS, type PlanKey } from "../factory/config/credits.js";
import type { BillingEvent } from "./provider.js";
import {
  clearPendingCreditPlan,
  endCreditSubscription,
  linkSubscription,
  lockCreditAccountByCustomer,
  setCreditPlan,
  setCreditPlanPeriod,
  setPendingCreditPlan,
} from "./stores/billing-store.js";

export interface CreditEffect {

  effect:
    | null
    | "topup_granted"
    | "plan_granted"
    | "upgrade_granted"
    | "downgrade_pending"
    | "plan_unchanged"
    | "subscription_linked"
    | "subscription_ended";
  grantedCredits?: number;
  plan?: PlanKey | null;
}

const NOTHING: CreditEffect = { effect: null };

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => (value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {});
const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const secs = (value: unknown): Date | null => (typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000) : null);
const list = (value: unknown): Obj[] => {
  const data = obj(value)["data"];
  return Array.isArray(data) ? data.map(obj) : [];
};

function priceIdOf(item: Obj): string | null {
  const price = item["price"];
  return (
    str(price) ??
    str(obj(price)["id"]) ??
    str(obj(obj(item["pricing"])["price_details"])["price"]) ??
    str(obj(item["plan"])["id"])
  );
}

function planOf(prices: CreditPrices, items: Obj[]): { plan: PlanKey; item: Obj } | null {
  for (const item of items) {
    const product = productForPrice(prices, priceIdOf(item));
    if (product && "plan" in product) return { plan: product.plan, item };
  }
  return null;
}

const subscriptionOfInvoice = (invoice: Obj): string | null =>
  str(invoice["subscription"]) ?? str(obj(obj(invoice["parent"])["subscription_details"])["subscription"]);

function subscriptionPeriod(subscription: Obj, item: Obj | null): { start: Date; end: Date } | null {
  const start = secs(subscription["current_period_start"]) ?? secs(item?.["current_period_start"]);
  const end = secs(subscription["current_period_end"]) ?? secs(item?.["current_period_end"]);
  return start && end && end > start ? { start, end } : null;
}

interface AccountRow {
  accountId: string;
  plan: PlanKey | null;
  periodEnd: Date | null;
}

async function accountForCustomer(db: PoolClient, provider: string, customerId: string): Promise<AccountRow | null> {
  const { rows } = await lockCreditAccountByCustomer(db, provider, customerId);
  const row = rows[0];
  if (!row) return null;
  return {
    accountId: row["account_id"] as string,
    plan: (row["credit_plan"] as PlanKey | null) ?? null,
    periodEnd: (row["credit_period_end"] as Date | null) ?? null,
  };
}

export async function applyCreditEvent(
  db: PoolClient,
  provider: string,
  event: BillingEvent,
  prices: CreditPrices,
  options: { stale?: boolean; now?: Date } = {},
): Promise<CreditEffect> {
  if (!event.customerId) return NOTHING;
  const at = event.created ?? options.now ?? new Date();
  const o = event.object;

  switch (event.type) {
    case "checkout.session.completed": {
      const account = await accountForCustomer(db, provider, event.customerId);
      if (!account) return NOTHING;
      const metadata = obj(o["metadata"]);
      if (o["mode"] === "payment") {
        const pack = metadata["windkeel_topup"];
        if (!isTopupKey(pack) || o["payment_status"] !== "paid") return NOTHING;
        const sessionId = str(o["id"]) ?? event.id;
        await enableCredits(db, account.accountId, at);
        const granted = await grantCredits(db, {
          accountId: account.accountId,
          source: "topup",
          product: pack,
          amountMicro: creditsToMicro(TOPUP_PACKS[pack].credits),
          ...topupWindow(at),
          idempotencyKey: `${provider}:topup:${sessionId}`,
          providerRef: sessionId,
        });
        return granted.granted ? { effect: "topup_granted", grantedCredits: TOPUP_PACKS[pack].credits } : NOTHING;
      }
      if (o["mode"] === "subscription") {
        await enableCredits(db, account.accountId, at);
        await linkSubscription(db, account.accountId, str(o["subscription"]));
        return { effect: "subscription_linked", plan: account.plan };
      }
      return NOTHING;
    }

    case "invoice.paid":
    case "invoice.payment_succeeded": {
      const reason = o["billing_reason"];
      if (reason !== "subscription_create" && reason !== "subscription_cycle") return NOTHING;
      const found = planOf(prices, list(o["lines"]));
      if (!found) return NOTHING;
      const period = obj(found.item["period"]);
      const start = secs(period["start"]);
      const end = secs(period["end"]);
      const invoiceId = str(o["id"]);
      if (!start || !end || end <= start || !invoiceId) return NOTHING;
      const account = await accountForCustomer(db, provider, event.customerId);
      if (!account) return NOTHING;
      await enableCredits(db, account.accountId, at);
      const plan = PLANS[found.plan];
      const granted = await grantCredits(db, {
        accountId: account.accountId,
        source: "plan",
        product: plan.key,
        amountMicro: creditsToMicro(plan.credits),
        startsAt: start,
        expiresAt: end,
        idempotencyKey: `${provider}:plan:${invoiceId}`,
        providerRef: invoiceId,
      });

      if (!options.stale && (!account.periodEnd || end >= account.periodEnd)) {
        await setCreditPlanPeriod(db, account.accountId, plan.key, start, end, subscriptionOfInvoice(o));
      }
      return granted.granted ? { effect: "plan_granted", grantedCredits: plan.credits, plan: plan.key } : NOTHING;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated": {
      if (options.stale) return NOTHING;
      const found = planOf(prices, list(o["items"]));
      const account = await accountForCustomer(db, provider, event.customerId);
      if (!account || !found) return NOTHING;
      const subscriptionId = str(o["id"]);
      await linkSubscription(db, account.accountId, subscriptionId);

      if (account.plan === null) return { effect: "subscription_linked", plan: null };
      const current = PLANS[account.plan];
      const next = PLANS[found.plan];
      if (next.credits === current.credits) {
        await clearPendingCreditPlan(db, account.accountId);
        return { effect: "plan_unchanged", plan: current.key };
      }
      if (next.credits < current.credits) {
        await setPendingCreditPlan(db, account.accountId, next.key);
        return { effect: "downgrade_pending", plan: next.key };
      }

      const period = subscriptionPeriod(o, found.item);
      const end = period?.end ?? account.periodEnd;
      await setCreditPlan(db, account.accountId, next.key);
      if (!end || end <= at) return { effect: "upgrade_granted", grantedCredits: 0, plan: next.key };
      const difference = next.credits - current.credits;
      const periodKey = Math.floor((period?.start ?? end).getTime() / 1000);
      const granted = await grantCredits(db, {
        accountId: account.accountId,
        source: "upgrade",
        product: next.key,
        amountMicro: creditsToMicro(difference),
        startsAt: at,
        expiresAt: end,
        idempotencyKey: `${provider}:upgrade:${subscriptionId ?? event.customerId}:${periodKey}:${next.key}`,
        providerRef: event.id,
      });
      return { effect: "upgrade_granted", grantedCredits: granted.granted ? difference : 0, plan: next.key };
    }

    case "customer.subscription.deleted": {
      if (options.stale) return NOTHING;
      const account = await accountForCustomer(db, provider, event.customerId);
      if (!account) return NOTHING;

      await endCreditSubscription(db, account.accountId);
      return { effect: "subscription_ended", plan: null };
    }

    default:
      return NOTHING;
  }
}

