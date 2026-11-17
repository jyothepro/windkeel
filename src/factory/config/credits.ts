export const MICRO = 1_000_000;
export const CREDIT_USD = 0.01;
export const COMPUTE_CREDITS_PER_MINUTE = 2;
export const TRIAL_CREDITS = 500;
export const TOPUP_EXPIRY_MONTHS = 12;
const ALERT_THRESHOLDS = [50, 80, 100] as const;

export type PlanKey = "starter" | "pro" | "team" | "scale";
export type TopupKey = "topup_10" | "topup_25" | "topup_50";

export interface Plan {
  key: PlanKey;
  name: string;
  priceUsd: number;
  credits: number;
}

export interface TopupPack {
  key: TopupKey;
  priceUsd: number;
  credits: number;
}

export const PLANS: Readonly<Record<PlanKey, Plan>> = {
  starter: { key: "starter", name: "Starter", priceUsd: 20, credits: 2_000 },
  pro: { key: "pro", name: "Pro", priceUsd: 50, credits: 5_250 },
  team: { key: "team", name: "Team", priceUsd: 100, credits: 11_000 },
  scale: { key: "scale", name: "Scale", priceUsd: 250, credits: 30_000 },
};

export const TOPUP_PACKS: Readonly<Record<TopupKey, TopupPack>> = {
  topup_10: { key: "topup_10", priceUsd: 10, credits: 1_000 },
  topup_25: { key: "topup_25", priceUsd: 25, credits: 2_500 },
  topup_50: { key: "topup_50", priceUsd: 50, credits: 5_000 },
};

export const PLAN_KEYS = Object.keys(PLANS) as PlanKey[];
export const TOPUP_KEYS = Object.keys(TOPUP_PACKS) as TopupKey[];

export function isPlanKey(value: unknown): value is PlanKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PLANS, value);
}
export function isTopupKey(value: unknown): value is TopupKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(TOPUP_PACKS, value);
}

export function bonusPct(item: { priceUsd: number; credits: number }): number {
  const face = item.priceUsd / CREDIT_USD;
  return Math.round(((item.credits - face) / face) * 10_000) / 100;
}

export const creditsToMicro = (credits: number): number => Math.round(credits * MICRO);
export const microToCredits = (micro: number): number => micro / MICRO;
export const microCreditsToMicroUsd = (micro: number): number => Math.round(micro / 100);

export function billedSeconds(sandboxMs: number | null | undefined): number {
  if (sandboxMs === null || sandboxMs === undefined || !Number.isFinite(sandboxMs) || sandboxMs <= 0) return 0;
  return Math.ceil(sandboxMs / 1000);
}

export function computeMicro(seconds: number): number {
  return Math.round((seconds * COMPUTE_CREDITS_PER_MINUTE * MICRO) / 60);
}

export function usdToMicro(usd: number): number {
  return Math.round((usd / CREDIT_USD) * MICRO);
}

export interface CostLine {
  kind: "model" | "sandbox";
  usd: number | null;
  keySource: string | null;
  sandboxMs: number | null;
}

export interface PricedLine {
  kind: "compute" | "ai";
  amountMicro: number;
  sandboxSeconds: number | null;
  unpriced: boolean;
}

export interface ComputeTally {
  ms: number;
  seconds: number;
  micro: number;
}

export const NO_COMPUTE: Readonly<ComputeTally> = Object.freeze({ ms: 0, seconds: 0, micro: 0 });

function priceCompute(tally: Readonly<ComputeTally>, sandboxMs: number | null | undefined): { line: PricedLine; tally: ComputeTally } {
  const added = sandboxMs !== null && sandboxMs !== undefined && Number.isFinite(sandboxMs) && sandboxMs > 0 ? sandboxMs : 0;
  const ms = tally.ms + added;
  const seconds = Math.max(tally.seconds, billedSeconds(ms));
  const micro = Math.max(tally.micro, computeMicro(seconds));
  return {
    line: { kind: "compute", amountMicro: micro - tally.micro, sandboxSeconds: seconds - tally.seconds, unpriced: false },
    tally: { ms, seconds, micro },
  };
}

export function priceCostLine(line: CostLine): PricedLine {
  if (line.kind === "sandbox") return priceCompute(NO_COMPUTE, line.sandboxMs).line;
  if (line.usd === null) return { kind: "ai", amountMicro: 0, sandboxSeconds: null, unpriced: true };
  if (line.keySource === "customer") return { kind: "ai", amountMicro: 0, sandboxSeconds: null, unpriced: false };
  return { kind: "ai", amountMicro: usdToMicro(line.usd), sandboxSeconds: null, unpriced: false };
}

export function priceCostLines(
  lines: ReadonlyArray<CostLine & { engineeringRunId: string }>,
  debited: ReadonlyMap<string, Readonly<ComputeTally>> = new Map(),
): PricedLine[] {
  const tallies = new Map(debited);
  return lines.map((line) => {
    if (line.kind !== "sandbox") return priceCostLine(line);
    const priced = priceCompute(tallies.get(line.engineeringRunId) ?? NO_COMPUTE, line.sandboxMs);
    tallies.set(line.engineeringRunId, priced.tally);
    return priced.line;
  });
}

export function billableOverageMicro(overageMicro: number, capMicro: number | null, billedMicro: number): number {
  if (capMicro === null || overageMicro <= 0) return 0;
  return Math.max(0, Math.min(overageMicro, capMicro - billedMicro));
}

export type GrantSource = "trial" | "plan" | "upgrade" | "topup";

export interface GrantState {
  id: string;
  source: GrantSource;
  startsAt: Date;
  expiresAt: Date;
  createdAt: Date;
  remainingMicro: number;
}

export const isPlanGrant = (grant: { source: GrantSource }): boolean => grant.source === "plan" || grant.source === "upgrade";

export const isLive = (grant: { startsAt: Date; expiresAt: Date }, at: Date): boolean =>
  grant.startsAt.getTime() <= at.getTime() && at.getTime() < grant.expiresAt.getTime();

export function spendOrder<G extends Pick<GrantState, "id" | "source" | "expiresAt" | "createdAt">>(grants: readonly G[]): G[] {
  return [...grants].sort((a, b) => {
    const plan = Number(isPlanGrant(b)) - Number(isPlanGrant(a));
    if (plan !== 0) return plan;
    const expiry = a.expiresAt.getTime() - b.expiresAt.getTime();
    if (expiry !== 0) return expiry;
    const created = a.createdAt.getTime() - b.createdAt.getTime();
    if (created !== 0) return created;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export interface Allocation {
  allocations: Array<{ grantId: string; amountMicro: number }>;
  overageMicro: number;
}

export function allocate(amountMicro: number, grants: GrantState[], at: Date): Allocation {
  const allocations: Allocation["allocations"] = [];
  let left = amountMicro;
  for (const grant of spendOrder(grants.filter((g) => g.remainingMicro > 0 && isLive(g, at)))) {
    if (left <= 0) break;
    const take = Math.min(left, grant.remainingMicro);
    grant.remainingMicro -= take;
    left -= take;
    allocations.push({ grantId: grant.id, amountMicro: take });
  }
  return { allocations, overageMicro: left };
}

export function addMonths(from: Date, months: number): Date {
  const target = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      target.getUTCFullYear(),
      target.getUTCMonth(),
      Math.min(from.getUTCDate(), lastDay),
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}

export function daysUntil(end: Date, now: Date): number {
  return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86_400_000));
}

export function thresholdsReached(usedMicro: number, includedMicro: number): number[] {
  if (includedMicro <= 0) return [];
  return ALERT_THRESHOLDS.filter((pct) => usedMicro * 100 >= includedMicro * pct);
}

export function formatCredits(credits: number): string {
  return credits.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
