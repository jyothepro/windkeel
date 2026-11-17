import { z } from "zod";
import {
  jsonObject,
} from "./schemas.js";
import {
  iso,
  id,
} from "./route-common.js";

export const Period = z.object({ start: iso, end: iso, label: z.string() });
export const BudgetFields = z.object({
  monthlyLimitUsd: z.number().nullable(),
  alertThresholdPct: z.number().nullable(),
  defaultRunCapUsd: z.number().nullable(),
  includeCustomerKeySpend: z.boolean(),
  updatedByPrincipalId: id.nullable(),
  updatedAt: iso.nullable(),
});
export const Budget = BudgetFields.extend({ organizationId: id, canManage: z.boolean() });
export const Usage = z.object({
  organizationId: id,
  period: Period,
  raw: z.object({ windkeelModelUsd: z.number(), customerModelUsd: z.number(), sandboxUsd: z.number() }),
  verification: z.object({ modelUsd: z.number(), sandboxUsd: z.number(), totalUsd: z.number(), runs: z.number() }),
  unpriced: z.object({ calls: z.number(), estimatedWindkeelUsd: z.number(), estimatedCustomerUsd: z.number() }),
  billable: z.object({ aiUsd: z.number(), computeFeeUsd: z.number(), verificationFeeUsd: z.number() }),
  budget: BudgetFields.extend({ spentUsd: z.number(), remainingUsd: z.number().nullable(), exhausted: z.boolean() }),
  plan: z.string().nullable(),
  billingStatus: z.string().nullable(),
  alerts: z.array(z.object({ sentAt: iso })),
});
export const Billing = z.object({
  organizationId: id,
  provider: z.string(),
  plan: z.string().nullable(),
  status: z.string().nullable(),
  statusReason: z.string().nullable(),
  hasCustomer: z.boolean(),
  selfManaged: z.boolean(),
  canManage: z.boolean(),
  pricing: jsonObject.nullable(),
});
export const Url = z.object({ url: z.string() });
export const CatalogEntry = z.object({ key: z.string(), credits: z.number(), bonusPct: z.number(), purchasable: z.boolean() });
export const Catalog = z.object({
  creditUsd: z.number(),
  computeCreditsPerMinute: z.number(),
  plans: z.array(CatalogEntry),
  topups: z.array(CatalogEntry),
});
export const Balance = z.union([
  z.object({ organizationId: id, onCredits: z.literal(false), canManage: z.boolean(), catalog: Catalog }),
  z.object({
    organizationId: id,
    onCredits: z.literal(true),
    plan: z.string().nullable(),
    pendingPlan: z.string().nullable(),
    period: z.object({ start: iso, end: iso, basis: z.string(), daysToReset: z.number() }),
    planCredits: z.object({ included: z.number(), used: z.number(), left: z.number() }),
    topups: z.array(
      z.object({
        grantId: id,
        source: z.string(),
        product: z.string().nullable(),
        credits: z.number(),
        left: z.number(),
        grantedAt: iso,
        expiresAt: iso,
      }),
    ),
    overage: z.object({
      enabled: z.boolean(),
      capCredits: z.number().nullable(),
      billedCredits: z.number(),
      unbilledCredits: z.number(),
    }),
    availableCredits: z.number(),
    admits: z.boolean(),
    alerts: z.array(z.object({ kind: z.string(), usedCredits: z.number(), limitCredits: z.number(), raisedAt: iso })),
    canManage: z.boolean(),
    catalog: Catalog,
  }),
]);
export const Statement = z.object({
  organizationId: id,
  period: Period,
  rows: z.array(
    z.object({
      runId: id,
      repositoryId: id,
      repository: z.string().nullable(),
      role: z.string(),
      kind: z.enum(["compute", "ai"]),
      model: z.string().nullable(),
      sandboxSeconds: z.number(),
      tokensIn: z.number(),
      tokensOut: z.number(),
      credits: z.number(),
      micro: z.number(),
    }),
  ),
  byRun: z.array(z.object({ runId: id, repository: z.string().nullable(), credits: z.number() })),
  byRepository: z.array(z.object({ repositoryId: id, repository: z.string().nullable(), credits: z.number() })),
  byRole: z.array(z.object({ role: z.string(), credits: z.number() })),
  totals: z.object({ credits: z.number(), totalMicro: z.number() }),
});
export const ChangePlan = z.object({
  plan: z.string(),
  from: z.string().optional(),
  effective: z.enum(["unchanged", "now", "period_end"]),
});
export const BillingWebhook = z.object({ ok: z.literal(true), duplicate: z.boolean().optional(), type: z.string().optional() });
export const Signup = z.object({ accountId: id, organizationId: id, principalId: id, trialCredits: z.number() });
export const InstallLink = z.object({ url: z.string(), expiresAt: iso });
export const LinkInstallation = z.object({ organizationId: id, installationId: z.number(), granted: z.number() });
