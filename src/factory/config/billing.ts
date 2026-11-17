import { PLAN_KEYS, TOPUP_KEYS, type PlanKey, type TopupKey } from "./credits.js";

export type BillingProviderName = "none" | "fake" | "stripe";

export class BillingConfigError extends Error {
  override readonly name = "BillingConfigError";
  constructor(message: string, readonly variables: string[]) {
    super(message);
  }
}

export interface PricingConfig {
  aiMultiplier: number;
  computeMultiplier: number;
  verificationFeeUsd: number;
}

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  meterEventName: string;
  priceId: string;
  apiBase: string;
}

export interface BillingConfig {
  provider: BillingProviderName;
  stripe?: StripeConfig | undefined;
  fakeWebhookSecret: string | undefined;
  pricing: PricingConfig;
  prices: CreditPrices;
}

export interface CreditPrices {
  plans: Record<PlanKey, string | undefined>;
  topups: Record<TopupKey, string | undefined>;
}

export const PLAN_PRICE_VARIABLES: Readonly<Record<PlanKey, string>> = {
  starter: "STRIPE_PRICE_STARTER",
  pro: "STRIPE_PRICE_PRO",
  team: "STRIPE_PRICE_TEAM",
  scale: "STRIPE_PRICE_SCALE",
};
export const TOPUP_PRICE_VARIABLES: Readonly<Record<TopupKey, string>> = {
  topup_10: "STRIPE_PRICE_TOPUP_10",
  topup_25: "STRIPE_PRICE_TOPUP_25",
  topup_50: "STRIPE_PRICE_TOPUP_50",
};
const CREDIT_PRICE_VARIABLES: readonly string[] = [
  ...Object.values(PLAN_PRICE_VARIABLES),
  ...Object.values(TOPUP_PRICE_VARIABLES),
];

const fakePriceId = (key: PlanKey | TopupKey): string => `price_fake_${key}`;

export function loadCreditPrices(env: NodeJS.ProcessEnv = process.env, provider: BillingProviderName = "fake"): CreditPrices {
  const pick = <K extends PlanKey | TopupKey>(keys: K[], names: Readonly<Record<K, string>>): Record<K, string | undefined> => {
    const out = {} as Record<K, string | undefined>;
    for (const key of keys) out[key] = set(env, names[key]) ?? (provider === "fake" ? fakePriceId(key) : undefined);
    return out;
  };
  return { plans: pick(PLAN_KEYS, PLAN_PRICE_VARIABLES), topups: pick(TOPUP_KEYS, TOPUP_PRICE_VARIABLES) };
}

export function productForPrice(prices: CreditPrices, priceId: unknown): { plan: PlanKey } | { topup: TopupKey } | null {
  if (typeof priceId !== "string" || priceId === "") return null;
  for (const key of PLAN_KEYS) if (prices.plans[key] === priceId) return { plan: key };
  for (const key of TOPUP_KEYS) if (prices.topups[key] === priceId) return { topup: key };
  return null;
}

export const DEFAULT_PRICING: PricingConfig = { aiMultiplier: 1, computeMultiplier: 1, verificationFeeUsd: 0 };

const PRICING_VARIABLES = {
  aiMultiplier: "WINDKEEL_BILLING_AI_MULTIPLIER",
  computeMultiplier: "WINDKEEL_BILLING_COMPUTE_MULTIPLIER",
  verificationFeeUsd: "WINDKEEL_BILLING_VERIFICATION_FEE_USD",
} as const;

const STRIPE_REQUIRED_VARIABLES: readonly string[] = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_METER_EVENT_NAME",
  "STRIPE_PRICE_ID",
  ...CREDIT_PRICE_VARIABLES,
];

const set = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value ? value : undefined;
};

export function loadPricing(env: NodeJS.ProcessEnv = process.env): PricingConfig {
  const pricing = { ...DEFAULT_PRICING };
  for (const [field, name] of Object.entries(PRICING_VARIABLES) as Array<[keyof PricingConfig, string]>) {
    const raw = set(env, name);
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw new BillingConfigError(`${name} must be a non-negative number`, [name]);
    }
    pricing[field] = value;
  }
  return pricing;
}

export function loadBillingConfig(env: NodeJS.ProcessEnv = process.env): BillingConfig {
  const raw = (set(env, "WINDKEEL_BILLING_PROVIDER") ?? "fake").toLowerCase();
  if (raw !== "none" && raw !== "fake" && raw !== "stripe") {
    throw new BillingConfigError(
      `WINDKEEL_BILLING_PROVIDER must be fake or stripe (or none); it is set to something else`,
      ["WINDKEEL_BILLING_PROVIDER"],
    );
  }
  const pricing = loadPricing(env);
  const fakeWebhookSecret = set(env, "WINDKEEL_FAKE_BILLING_WEBHOOK_SECRET");
  if (raw !== "stripe") return { provider: raw, pricing, fakeWebhookSecret, prices: loadCreditPrices(env, raw) };

  const missing = STRIPE_REQUIRED_VARIABLES.filter((name) => set(env, name) === undefined);
  if (missing.length) {
    throw new BillingConfigError(
      `WINDKEEL_BILLING_PROVIDER=stripe needs ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} not set. ` +
        "Set them, or unset WINDKEEL_BILLING_PROVIDER to use the fake provider.",
      missing,
    );
  }
  return {
    provider: "stripe",
    pricing,
    fakeWebhookSecret,
    prices: loadCreditPrices(env, "stripe"),
    stripe: {
      secretKey: set(env, "STRIPE_SECRET_KEY")!,
      webhookSecret: set(env, "STRIPE_WEBHOOK_SECRET")!,
      meterEventName: set(env, "STRIPE_METER_EVENT_NAME")!,
      priceId: set(env, "STRIPE_PRICE_ID")!,
      apiBase: (set(env, "STRIPE_API_BASE") ?? "https://api.stripe.com").replace(/\/+$/, ""),
    },
  };
}

export function billingConfigProblem(env: NodeJS.ProcessEnv = process.env): { ok: true; summary: string } | { ok: false; summary: string } {
  try {
    const config = loadBillingConfig(env);
    const knobs = `AI ×${config.pricing.aiMultiplier}, compute ×${config.pricing.computeMultiplier}, ` +
      `$${config.pricing.verificationFeeUsd} per verification`;
    const priced =
      Object.values(config.prices.plans).filter(Boolean).length + Object.values(config.prices.topups).filter(Boolean).length;
    return {
      ok: true,
      summary: `billing provider ${config.provider} (${knobs}; credit plans and top-ups: ${priced} of ${CREDIT_PRICE_VARIABLES.length} priced)`,
    };
  } catch (error) {
    if (error instanceof BillingConfigError) return { ok: false, summary: error.message };
    throw error;
  }
}

export type SelfServeMode = "off" | "invite";

export function selfServeMode(env: NodeJS.ProcessEnv = process.env): SelfServeMode {
  const raw = (env["WINDKEEL_SELF_SERVE_SIGNUP"] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "invite" ? "invite" : "off";
}

export { TRIAL_CREDITS } from "./credits.js";
