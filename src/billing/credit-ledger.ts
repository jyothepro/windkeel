

import type { Pool, PoolClient } from "pg";
import {
  addMonths,
  allocate,
  billableOverageMicro,
  isLive,
  isPlanGrant,
  microToCredits,
  priceCostLines,
  thresholdsReached,
  TOPUP_EXPIRY_MONTHS,
  type ComputeTally,
  type GrantSource,
  type GrantState,
  type PlanKey,
  type PricedLine,
} from "../factory/config/credits.js";
import { periodContaining, type BillingPeriod } from "./usage.js";
import {
  costLineSql,
  enableCreditBilling,
  insertCreditAlert,
  insertCreditAllocation,
  insertCreditDebit,
  insertCreditGrant,
  lockCreditAccountRow,
  selectAccountOfOrganization,
  selectCreditAccountIds,
  selectCreditAccountRow,
  selectCreditAlerts,
  selectDebitedCompute,
  selectGrantsWithRemaining,
  selectOverageEligibility,
  selectOverageInPeriod,
  selectUndebitedCostLines,
  updateOverageSettings,
} from "./stores/credit-ledger-store.js";
import { withTransaction } from "../factory/db/transaction.js";

type Queryable = Pool | PoolClient;

export interface CreditAccount {
  accountId: string;

  since: Date;
  plan: PlanKey | null;
  pendingPlan: PlanKey | null;
  subscriptionId: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  overageEnabled: boolean;

  overageEnabledAt: Date | null;

  overageCapMicro: number | null;
}

export class CreditsExhaustedError extends Error {
  override readonly name = "CreditsExhaustedError";
  readonly code = "credits_exhausted";
  constructor(
    readonly organizationId: string,
    readonly overage: "off" | "cap_reached",
  ) {
    super(
      overage === "off"
        ? "this organization is out of credits, so no new run starts until it buys a top-up, changes plan, or an admin turns on overage (Settings → Billing)"
        : "this organization is out of credits and has reached its overage cap, so no new run starts until it buys a top-up, changes plan, or an admin raises the cap (Settings → Billing)",
    );
  }
}

export class CreditSettingsError extends Error {
  override readonly name = "CreditSettingsError";
}

const date = (value: unknown): Date | null => (value === null || value === undefined ? null : (value as Date));

function rowToCreditAccount(row: Record<string, unknown>): CreditAccount | null {
  const since = date(row["credit_billing_since"]);
  if (!since) return null;
  const cap = row["overage_cap_credits"];
  return {
    accountId: row["account_id"] as string,
    since,
    plan: (row["credit_plan"] as PlanKey | null) ?? null,
    pendingPlan: (row["pending_credit_plan"] as PlanKey | null) ?? null,
    subscriptionId: (row["provider_subscription_id"] as string | null) ?? null,
    periodStart: date(row["credit_period_start"]),
    periodEnd: date(row["credit_period_end"]),
    overageEnabled: Boolean(row["overage_enabled"]),
    overageEnabledAt: date(row["overage_enabled_at"]),
    overageCapMicro: cap === null || cap === undefined ? null : Math.round(Number(cap) * 1_000_000),
  };
}

export async function getCreditAccount(db: Queryable, accountId: string): Promise<CreditAccount | null> {
  const { rows } = await selectCreditAccountRow(db, accountId);
  return rows[0] ? rowToCreditAccount(rows[0]) : null;
}

export async function accountOfOrganization(db: Queryable, organizationId: string): Promise<string | null> {
  const { rows } = await selectAccountOfOrganization(db, organizationId);
  return (rows[0]?.["account_id"] as string | undefined) ?? null;
}

export async function enableCredits(db: Queryable, accountId: string, at: Date): Promise<void> {
  await enableCreditBilling(db, accountId, at);
}

export interface GrantInput {
  accountId: string;
  source: GrantSource;
  product: string | null;
  amountMicro: number;
  startsAt: Date;
  expiresAt: Date;
  idempotencyKey: string;
  providerRef?: string | null;
}

export async function grantCredits(db: Queryable, input: GrantInput): Promise<{ granted: boolean; grantId: string | null }> {
  if (!Number.isInteger(input.amountMicro) || input.amountMicro <= 0) throw new CreditSettingsError("a grant is a positive whole number of micro-credits");
  const { rows } = await insertCreditGrant(db, {
    accountId: input.accountId,
    source: input.source,
    product: input.product,
    amountMicro: input.amountMicro,
    startsAt: input.startsAt,
    expiresAt: input.expiresAt,
    idempotencyKey: input.idempotencyKey,
    providerRef: input.providerRef ?? null,
  });
  return rows[0] ? { granted: true, grantId: rows[0]["id"] as string } : { granted: false, grantId: null };
}

export const topupWindow = (at: Date): { startsAt: Date; expiresAt: Date } => ({ startsAt: at, expiresAt: addMonths(at, TOPUP_EXPIRY_MONTHS) });

interface GrantRow extends GrantState {
  product: string | null;
  amountMicro: number;
}

async function loadGrants(db: Queryable, accountId: string, liveAfter: Date): Promise<GrantRow[]> {
  const { rows } = await selectGrantsWithRemaining(db, accountId, liveAfter);
  return rows.map((r) => ({
    id: r["id"] as string,
    source: r["source"] as GrantSource,
    product: (r["product"] as string | null) ?? null,
    amountMicro: Number(r["amount_micro"]),
    startsAt: r["starts_at"] as Date,
    expiresAt: r["expires_at"] as Date,
    createdAt: r["created_at"] as Date,
    remainingMicro: Number(r["remaining"]),
  }));
}

export type CreditRole = "maker" | "verifier" | "criteria";

export interface CostLineRow {
  costEventId: string;
  seq: string;
  engineeringRunId: string;
  organizationId: string;
  repositoryId: string;
  role: CreditRole;
  kind: "model" | "sandbox";
  model: string | null;
  keySource: string | null;
  usd: number | null;
  sandboxMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  recordedAt: Date;
}

export { costLineSql };

export function rowToCostLine(r: Record<string, unknown>): CostLineRow {
  const stage = r["stage_type"] as string;
  const role: CreditRole =
    r["kind"] === "sandbox"
      ? r["workspace_role"] === "verifier"
        ? "verifier"
        : "maker"
      : stage === "verification_run"
        ? "verifier"
        : stage === "criteria"
          ? "criteria"
          : "maker";
  const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    costEventId: r["id"] as string,
    seq: String(r["seq"]),
    engineeringRunId: r["engineering_run_id"] as string,
    organizationId: r["organization_id"] as string,
    repositoryId: r["repository_id"] as string,
    role,
    kind: r["kind"] as "model" | "sandbox",
    model: (r["model"] as string | null) ?? null,
    keySource: (r["key_source"] as string | null) ?? null,
    usd: n(r["usd"]),
    sandboxMs: n(r["sandbox_ms"]),
    tokensIn: n(r["tokens_in"]),
    tokensOut: n(r["tokens_out"]),
    recordedAt: r["recorded_at"] as Date,
  };
}

async function undebitedLines(db: Queryable, account: CreditAccount, until: Date): Promise<CostLineRow[]> {
  const { rows } = await selectUndebitedCostLines(db, account.accountId, account.since, until);
  return rows.map(rowToCostLine);
}

export async function debitedCompute(db: Queryable, lines: ReadonlyArray<Pick<CostLineRow, "engineeringRunId" | "kind">>): Promise<Map<string, ComputeTally>> {
  const runIds = [...new Set(lines.filter((l) => l.kind === "sandbox").map((l) => l.engineeringRunId))];
  const tallies = new Map<string, ComputeTally>();
  if (runIds.length === 0) return tallies;
  const { rows } = await selectDebitedCompute(db, runIds);
  for (const r of rows) {
    tallies.set(r["engineering_run_id"] as string, { ms: Number(r["ms"]), seconds: Number(r["seconds"]), micro: Number(r["micro"]) });
  }
  return tallies;
}

export interface PendingDebit {
  line: CostLineRow;
  priced: PricedLine;
  allocations: Array<{ grantId: string; amountMicro: number }>;
  overageMicro: number;
  overageBillableMicro: number;
}

interface CreditState {
  account: CreditAccount;
  grants: GrantRow[];

  pending: PendingDebit[];
}

function overageBillableAt(account: Pick<CreditAccount, "overageEnabled" | "overageEnabledAt">, at: Date): boolean {
  return account.overageEnabled && account.overageEnabledAt !== null && account.overageEnabledAt.getTime() <= at.getTime();
}

async function loadState(db: Queryable, account: CreditAccount, now: Date): Promise<CreditState> {
  const pendingLines = await undebitedLines(db, account, now);
  const earliest = pendingLines[0] && pendingLines[0].recordedAt < now ? pendingLines[0].recordedAt : now;
  const grants = await loadGrants(db, account.accountId, earliest);
  const priced = priceCostLines(pendingLines, await debitedCompute(db, pendingLines));
  const billedInPeriod = new Map<number, number>();
  const pending: PendingDebit[] = [];
  for (const [i, line] of pendingLines.entries()) {
    const linePriced = priced[i]!;
    const { allocations, overageMicro } = allocate(linePriced.amountMicro, grants, line.recordedAt);
    let overageBillable = 0;
    if (overageMicro > 0 && overageBillableAt(account, line.recordedAt)) {
      const period = creditPeriod(account, grants, line.recordedAt);
      const key = period.start.getTime();
      const billed = billedInPeriod.get(key) ?? (await overageInPeriod(db, account.accountId, period)).billed;
      overageBillable = billableOverageMicro(overageMicro, account.overageCapMicro, billed);
      billedInPeriod.set(key, billed + overageBillable);
    }
    pending.push({ line, priced: linePriced, allocations, overageMicro, overageBillableMicro: overageBillable });
  }
  return { account, grants, pending };
}

export interface CreditPeriod extends BillingPeriod {

  basis: "plan_grant" | "subscription" | "calendar_month";
}

export interface CreditBalance {
  accountId: string;
  plan: PlanKey | null;
  pendingPlan: PlanKey | null;
  period: CreditPeriod;

  planMicro: { included: number; used: number; left: number };

  topups: Array<{ grantId: string; source: GrantSource; product: string | null; grantedMicro: number; leftMicro: number; startsAt: Date; expiresAt: Date }>;
  overage: {
    enabled: boolean;
    capMicro: number | null;

    billedMicro: number;

    unbilledMicro: number;
  };
  availableMicro: number;

  admits: boolean;
}

function creditPeriod(account: CreditAccount, grants: readonly GrantState[], now: Date): CreditPeriod {
  const plan = grants.filter((g) => g.source === "plan" && isLive(g, now)).sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())[0];
  if (plan) return { start: plan.startsAt, end: plan.expiresAt, basis: "plan_grant" };
  if (account.periodStart && account.periodEnd && account.periodStart <= now && now < account.periodEnd) {
    return { start: account.periodStart, end: account.periodEnd, basis: "subscription" };
  }
  return { ...periodContaining(now), basis: "calendar_month" };
}

function balanceOf(state: CreditState, overageRows: { billed: number; unbilled: number }, now: Date): CreditBalance {
  const { account, grants, pending } = state;
  const period = creditPeriod(account, grants, now);
  const live = grants.filter((g) => isLive(g, now));
  const plan = live.filter(isPlanGrant);
  const included = plan.reduce((s, g) => s + g.amountMicro, 0);
  const planLeft = plan.reduce((s, g) => s + g.remainingMicro, 0);
  const topups = live
    .filter((g) => !isPlanGrant(g))
    .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime())
    .map((g) => ({
      grantId: g.id,
      source: g.source,
      product: g.product,
      grantedMicro: g.amountMicro,
      leftMicro: g.remainingMicro,
      startsAt: g.startsAt,
      expiresAt: g.expiresAt,
    }));
  let billed = overageRows.billed;
  let unbilled = overageRows.unbilled;
  for (const p of pending) {
    if (p.overageMicro === 0 || p.line.recordedAt < period.start || p.line.recordedAt >= period.end) continue;
    billed += p.overageBillableMicro;
    unbilled += p.overageMicro - p.overageBillableMicro;
  }
  const availableMicro = planLeft + topups.reduce((s, t) => s + t.leftMicro, 0);
  const capMicro = account.overageCapMicro;
  const admits = availableMicro > 0 || (account.overageEnabled && capMicro !== null && billed < capMicro);
  return {
    accountId: account.accountId,
    plan: account.plan,
    pendingPlan: account.pendingPlan,
    period,
    planMicro: { included, used: included - planLeft, left: planLeft },
    topups,
    overage: { enabled: account.overageEnabled, capMicro, billedMicro: billed, unbilledMicro: unbilled },
    availableMicro,
    admits,
  };
}

async function overageInPeriod(db: Queryable, accountId: string, period: BillingPeriod): Promise<{ billed: number; unbilled: number }> {
  const { rows } = await selectOverageInPeriod(db, accountId, period.start, period.end);
  return { billed: Number(rows[0]?.["billed"] ?? 0), unbilled: Number(rows[0]?.["unbilled"] ?? 0) };
}

export async function getCreditBalance(db: Queryable, accountId: string, now: Date = new Date()): Promise<CreditBalance | null> {
  const account = await getCreditAccount(db, accountId);
  if (!account) return null;
  const state = await loadState(db, account, now);
  const period = creditPeriod(account, state.grants, now);
  return balanceOf(state, await overageInPeriod(db, accountId, period), now);
}

export type CreditCheck =
  | { ok: true; onCredits: false }
  | { ok: true; onCredits: true; balance: CreditBalance }
  | { ok: false; onCredits: true; balance: CreditBalance; overage: "off" | "cap_reached" };

export async function checkCredits(db: Queryable, organizationId: string, now: Date = new Date()): Promise<CreditCheck> {
  const accountId = await accountOfOrganization(db, organizationId);
  if (!accountId) return { ok: true, onCredits: false };
  const balance = await getCreditBalance(db, accountId, now);
  if (!balance) return { ok: true, onCredits: false };
  if (balance.admits) return { ok: true, onCredits: true, balance };
  return { ok: false, onCredits: true, balance, overage: balance.overage.enabled ? "cap_reached" : "off" };
}

async function writeDebits(client: PoolClient, account: CreditAccount, now: Date): Promise<number> {
  const state = await loadState(client, account, now);
  let written = 0;
  for (const p of state.pending) {
    const { rows: inserted } = await insertCreditDebit(client, {
      accountId: account.accountId,
      organizationId: p.line.organizationId,
      costEventId: p.line.costEventId,
      engineeringRunId: p.line.engineeringRunId,
      repositoryId: p.line.repositoryId,
      role: p.line.role,
      kind: p.priced.kind,
      model: p.line.model,
      keySource: p.line.keySource,
      sandboxSeconds: p.priced.sandboxSeconds,
      tokensIn: p.line.tokensIn,
      tokensOut: p.line.tokensOut,
      unpriced: p.priced.unpriced,
      amountMicro: p.priced.amountMicro,
      overageMicro: p.overageMicro,
      overageBillableMicro: p.overageBillableMicro,
      recordedAt: p.line.recordedAt,
    });
    const debitId = inserted[0]?.["id"] as string | undefined;
    if (!debitId) continue;
    written += 1;
    for (const a of p.allocations) {
      await insertCreditAllocation(client, debitId, a.grantId, a.amountMicro);
    }
  }
  return written;
}

export async function syncCreditDebits(pool: Pool, accountId: string, now: Date = new Date()): Promise<number> {
  return withTransaction(pool, async (client) => {
    const { rows } = await lockCreditAccountRow(client, accountId);
    const account = rows[0] ? rowToCreditAccount(rows[0]) : null;

    if (!account) return 0;
    return writeDebits(client, account, now);
  });
}

export async function listCreditAccounts(db: Queryable): Promise<string[]> {
  const { rows } = await selectCreditAccountIds(db);
  return rows.map((r) => r["account_id"] as string);
}

export type CreditAlertKind = "plan_50" | "plan_80" | "plan_100" | "overage_cap";

export interface CreditAlert {
  kind: CreditAlertKind;
  periodStart: Date;
  usedMicro: number;
  limitMicro: number;
  raisedAt: Date;
}

export async function raiseCreditAlerts(db: Queryable, accountId: string, now: Date = new Date()): Promise<CreditAlertKind[]> {
  const balance = await getCreditBalance(db, accountId, now);
  if (!balance) return [];
  const due: Array<{ kind: CreditAlertKind; used: number; limit: number }> = thresholdsReached(
    balance.planMicro.used,
    balance.planMicro.included,
  ).map((pct) => ({ kind: `plan_${pct}` as CreditAlertKind, used: balance.planMicro.used, limit: balance.planMicro.included }));
  const cap = balance.overage.capMicro;
  if (balance.overage.enabled && cap !== null && balance.overage.billedMicro >= cap) {
    due.push({ kind: "overage_cap", used: balance.overage.billedMicro, limit: cap });
  }
  const raised: CreditAlertKind[] = [];
  for (const alert of due) {
    const result = await insertCreditAlert(db, accountId, balance.period.start, alert.kind, alert.used, alert.limit);
    if (result.rowCount === 1) raised.push(alert.kind);
  }
  return raised;
}

export async function listCreditAlerts(db: Queryable, accountId: string, periodStart: Date): Promise<CreditAlert[]> {
  const { rows } = await selectCreditAlerts(db, accountId, periodStart);
  return rows.map((r) => ({
    kind: r["kind"] as CreditAlertKind,
    periodStart: r["period_start"] as Date,
    usedMicro: Number(r["used_micro"]),
    limitMicro: Number(r["limit_micro"]),
    raisedAt: r["raised_at"] as Date,
  }));
}

export interface OverageInput {
  enabled: boolean;
  capCredits: number | null;
}

export function parseOverageInput(body: unknown): OverageInput {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new CreditSettingsError("a JSON object is required");
  const input = body as Record<string, unknown>;
  if (typeof input["enabled"] !== "boolean") throw new CreditSettingsError("enabled must be true or false");
  const cap = input["capCredits"] ?? null;
  if (cap !== null && (typeof cap !== "number" || !Number.isFinite(cap) || cap < 0)) {
    throw new CreditSettingsError("capCredits must be a non-negative number of credits, or null");
  }
  if (input["enabled"] && cap === null) throw new CreditSettingsError("overage needs a monthly cap (capCredits)");
  return { enabled: input["enabled"], capCredits: cap };
}

export async function setOverage(pool: Pool, accountId: string, input: OverageInput, at: Date = new Date()): Promise<void> {
  if (input.enabled) {
    const { rows } = await selectOverageEligibility(pool, accountId);
    if (rows[0]?.["on_credits"] && !rows[0]?.["subscribed"]) {
      throw new CreditSettingsError("overage is billed on a plan subscription, so this account needs a plan before it can turn overage on");
    }
  }
  await withTransaction(pool, async (client) => {
    const { rows } = await lockCreditAccountRow(client, accountId);
    const account = rows[0] ? rowToCreditAccount(rows[0]) : null;
    if (account) await writeDebits(client, account, at);
    const { rowCount } = await updateOverageSettings(client, accountId, input.enabled, input.capCredits, at);
    if (!rowCount) throw new CreditSettingsError("this account is not on a credit plan");
  });
}

export const credits = (micro: number): number => microToCredits(micro);
