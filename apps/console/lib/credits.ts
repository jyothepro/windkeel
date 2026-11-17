export interface CreditBalanceView {
  organizationId: string;
  onCredits: boolean;
  plan?: "starter" | "pro" | "team" | "scale" | null;
  pendingPlan?: CreditBalanceView["plan"];
  period?: { start: string; end: string; daysToReset: number };
  planCredits?: { included: number; used: number; left: number };
  topups?: Array<{ grantId: string; source: "trial" | "topup"; product: string | null; credits: number; left: number; expiresAt: string }>;
  overage?: { enabled: boolean; capCredits: number | null; billedCredits: number; unbilledCredits: number };
  availableCredits?: number;
  admits?: boolean;
  alerts?: Array<{ kind: "plan_50" | "plan_80" | "plan_100" | "overage_cap"; usedCredits: number; limitCredits: number; raisedAt: string }>;
  canManage?: boolean;
}

export interface RunReceiptView {
  runId: string;
  compute: Array<{ role: string; sandboxSeconds: number; sandboxMinutes: number; creditsPerMinute: number; credits: number }>;
  ai: Array<{ role: string; model: string | null; keySource: string; tokensIn: number; tokensOut: number; calls: number; unpricedCalls: number; credits: number }>;
  totals: { computeCredits: number; aiCredits: number; credits: number };
  settled: boolean;
}

export function credits(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const PLAN_NAME: Record<NonNullable<CreditBalanceView["plan"]>, string> = {
  starter: "Starter",
  pro: "Pro",
  team: "Team",
  scale: "Scale",
};

export const ALERT_LABEL: Record<NonNullable<CreditBalanceView["alerts"]>[number]["kind"], string> = {
  plan_50: "Half of this period's plan credits are used",
  plan_80: "80% of this period's plan credits are used",
  plan_100: "This period's plan credits are used up",
  overage_cap: "The overage cap is reached",
};

export function balanceSentence(b: CreditBalanceView): string {
  if (!b.onCredits) return "Not on a credit plan: billed by usage.";
  const left = `${credits(b.availableCredits ?? 0)} credits left`;
  const reset = b.period ? ` · plan resets in ${b.period.daysToReset} day${b.period.daysToReset === 1 ? "" : "s"}` : "";
  return `${left}${reset}`;
}

export function refusalSentence(b: CreditBalanceView): string | null {
  if (!b.onCredits || b.admits !== false) return null;
  return b.overage?.enabled
    ? "Out of credits and at the overage cap: new runs are refused until you top up, change plan, or raise the cap."
    : "Out of credits: new runs are refused until you top up or change plan. An admin can turn on overage with a monthly cap.";
}

export function roleLabel(role: string): string {
  return role === "verifier" ? "Verifier" : role === "criteria" ? "Acceptance criteria" : "Maker";
}
