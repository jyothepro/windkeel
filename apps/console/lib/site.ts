export const REPOSITORY_URL = "https://github.com/jyothepro/windkeel";

export const DEFAULT_INVITE_REQUEST_URL = `${REPOSITORY_URL}/issues/new?template=access.yml`;

export function inviteRequestUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = (env["NEXT_PUBLIC_INVITE_REQUEST_URL"] ?? "").trim();
  if (raw.startsWith("https://") || raw.startsWith("mailto:") || (raw.startsWith("/") && !raw.startsWith("//"))) return raw;
  return DEFAULT_INVITE_REQUEST_URL;
}

export interface Plan {
  id: "starter" | "pro" | "team" | "scale";
  name: string;
  usdPerMonth: number;
  credits: number;
  bonusPercent: number;
  forWhom: string;
}

export const PLANS: Plan[] = [
  { id: "starter", name: "Starter", usdPerMonth: 20, credits: 2_000, bonusPercent: 0, forWhom: "One developer trying the factory on a side project." },
  { id: "pro", name: "Pro", usdPerMonth: 50, credits: 5_250, bonusPercent: 5, forWhom: "A developer whose agents open pull requests every day." },
  { id: "team", name: "Team", usdPerMonth: 100, credits: 11_000, bonusPercent: 10, forWhom: "A team routing issues, Slack and Linear work to agents." },
  { id: "scale", name: "Scale", usdPerMonth: 250, credits: 30_000, bonusPercent: 20, forWhom: "Organizations running batches across many repositories." },
];

export const TOPUPS: Array<{ usd: number; credits: number }> = [
  { usd: 10, credits: 1_000 },
  { usd: 25, credits: 2_500 },
  { usd: 50, credits: 5_000 },
];

export const TRIAL_CREDITS = 500;

export const CREDITS_PER_SANDBOX_MINUTE = 2;

export function bonusPercent(plan: Pick<Plan, "usdPerMonth" | "credits">): number {
  return Math.round((plan.credits / (plan.usdPerMonth * 100) - 1) * 100);
}

export function usd(value: number): string {
  return `$${value.toLocaleString("en-US")}`;
}

export function creditCount(value: number): string {
  return value.toLocaleString("en-US");
}
