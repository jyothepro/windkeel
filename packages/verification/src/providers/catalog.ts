import type { Vendor } from "./types.js";

export type ModelProvider = "openai" | "anthropic" | "openrouter" | "openai-compatible";

export interface ProviderInfo {
  defaultBaseUrl?: string;
  egressHost?: string;
  firstPartyVendor?: Vendor;
  protocol: "anthropic" | "openai";
  authHeader: "Authorization" | "x-api-key";
}

export const PROVIDERS: Readonly<Record<ModelProvider, ProviderInfo>> = {
  openai: {
    defaultBaseUrl: "https://api.openai.com/v1",
    egressHost: "api.openai.com",
    firstPartyVendor: "openai",
    protocol: "openai",
    authHeader: "Authorization",
  },
  anthropic: {
    defaultBaseUrl: "https://api.anthropic.com/v1",
    egressHost: "api.anthropic.com",
    firstPartyVendor: "anthropic",
    protocol: "anthropic",
    authHeader: "x-api-key",
  },
  openrouter: {
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    egressHost: "openrouter.ai",
    protocol: "openai",
    authHeader: "Authorization",
  },
  "openai-compatible": { protocol: "openai", authHeader: "Authorization" },
};

export function isModelProvider(value: unknown): value is ModelProvider {
  return typeof value === "string" && Object.hasOwn(PROVIDERS, value);
}

export class UnknownProviderError extends Error {
  constructor(readonly provider: string) {
    super(
      `unknown model provider ${JSON.stringify(provider)}; expected one of ` +
        Object.keys(PROVIDERS).join(", "),
    );
    this.name = "UnknownProviderError";
  }
}

export class UnknownModelVendorError extends Error {
  constructor(
    readonly provider: ModelProvider,
    readonly model: string,
  ) {
    super(
      `cannot tell whose model ${JSON.stringify(model)} on provider ${provider} is; ` +
        `declare its vendor explicitly (ADR-0026 §5)`,
    );
    this.name = "UnknownModelVendorError";
  }
}

export class DeclaredVendorConflictError extends Error {
  constructor(
    readonly model: string,
    readonly declaredVendor: Vendor,
    readonly derivedVendor: Vendor,
  ) {
    super(
      `model ${JSON.stringify(model)} is ${derivedVendor}'s, but its vendor was declared as ` +
        `${JSON.stringify(declaredVendor)}`,
    );
    this.name = "DeclaredVendorConflictError";
  }
}

const SLUG_PREFIX_VENDORS: Readonly<Record<string, Vendor>> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  "meta-llama": "meta",
  meta: "meta",
  qwen: "alibaba",
  deepseek: "deepseek",
  "deepseek-ai": "deepseek",
  mistralai: "mistral",
  "x-ai": "xai",
  xai: "xai",
  moonshotai: "moonshot",
  "z-ai": "zhipu",
  cohere: "cohere",
  amazon: "amazon",
  microsoft: "microsoft",
};

const MODEL_FAMILY_VENDORS: ReadonlyArray<readonly [RegExp, Vendor]> = [
  [/^claude-/, "anthropic"],
  [/^(gpt-|chatgpt-|codex-|o[1-9](-|$))/, "openai"],
  [/^(gemini-|gemma-)/, "google"],
  [/^llama-?\d/, "meta"],
  [/^(qwen|qwq-)/, "alibaba"],
  [/^deepseek-/, "deepseek"],
  [/^(mistral-|mixtral-|codestral|devstral|magistral|ministral)/, "mistral"],
  [/^grok-/, "xai"],
  [/^kimi-/, "moonshot"],
  [/^glm-/, "zhipu"],
  [/^command-/, "cohere"],
];

function vendorFromModelName(model: string): Vendor | undefined {
  const name = model.trim().toLowerCase();
  const slash = name.indexOf("/");
  if (slash !== -1) {
    return SLUG_PREFIX_VENDORS[name.slice(0, slash)];
  }
  return MODEL_FAMILY_VENDORS.find(([pattern]) => pattern.test(name))?.[1];
}

export interface VendorQuery {
  provider: string;
  model: string;
  declaredVendor?: Vendor | undefined;
}

export function vendorOf({ provider, model, declaredVendor }: VendorQuery): Vendor {
  if (!isModelProvider(provider)) throw new UnknownProviderError(provider);
  const declared = declaredVendor?.trim() || undefined;
  const derived = PROVIDERS[provider].firstPartyVendor ?? vendorFromModelName(model);
  if (derived) {
    if (declared && declared !== derived) {
      throw new DeclaredVendorConflictError(model, declared, derived);
    }
    return derived;
  }
  if (declared) return declared;
  throw new UnknownModelVendorError(provider, model);
}

export interface ModelPrice {
  input: number;
  output: number;
  cachedInput?: number;
  cacheWriteInput?: number;
}

const perMillion = (input: number, output: number, cachedInput?: number, cacheWriteInput?: number): ModelPrice => ({
  input: input / 1_000_000,
  output: output / 1_000_000,
  ...(cachedInput === undefined ? {} : { cachedInput: cachedInput / 1_000_000 }),
  ...(cacheWriteInput === undefined ? {} : { cacheWriteInput: cacheWriteInput / 1_000_000 }),
});

const PRICES: Readonly<Record<string, ModelPrice>> = {
  "gpt-5": perMillion(1.25, 10, 0.125),
  "gpt-5-codex": perMillion(1.25, 10, 0.125),
  "gpt-5-mini": perMillion(0.25, 2, 0.025),
  "gpt-5-nano": perMillion(0.05, 0.4, 0.005),
  "gpt-4.1": perMillion(2, 8, 0.5),
  "gpt-4.1-mini": perMillion(0.4, 1.6, 0.1),
  o3: perMillion(2, 8, 0.5),
  "o4-mini": perMillion(1.1, 4.4, 0.275),
  "claude-sonnet-4-5": perMillion(3, 15, 0.3, 3.75),
  "claude-sonnet-4": perMillion(3, 15, 0.3, 3.75),
  "claude-opus-4-1": perMillion(15, 75, 1.5, 18.75),
  "claude-haiku-4-5": perMillion(1, 5, 0.1, 1.25),
  "claude-fable-5-1": perMillion(10, 50, 0.25, 12.5),
  "claude-opus-5-5": perMillion(4, 20, 0.2, 5),
  "claude-opus-5": perMillion(5, 25, 0.5, 6.25),
  "claude-sonnet-5-5": perMillion(2, 10, 0.2, 2.5),
  "claude-sonnet-5": perMillion(2, 10, 0.2, 2.5),
  "gemini-2.5-pro": perMillion(1.25, 10, 0.125),
  "gemini-2.5-flash": perMillion(0.3, 2.5, 0.03),
};

const SLUG_ALIASES: Readonly<Record<string, string>> = {
  "openai/gpt-5": "gpt-5",
  "openai/gpt-5-codex": "gpt-5-codex",
  "openai/gpt-5-mini": "gpt-5-mini",
  "openai/gpt-5-nano": "gpt-5-nano",
  "openai/gpt-4.1": "gpt-4.1",
  "openai/gpt-4.1-mini": "gpt-4.1-mini",
  "openai/o3": "o3",
  "openai/o4-mini": "o4-mini",
  "anthropic/claude-sonnet-4.5": "claude-sonnet-4-5",
  "anthropic/claude-sonnet-4": "claude-sonnet-4",
  "anthropic/claude-opus-4.1": "claude-opus-4-1",
  "anthropic/claude-haiku-4.5": "claude-haiku-4-5",
  "google/gemini-2.5-pro": "gemini-2.5-pro",
  "google/gemini-2.5-flash": "gemini-2.5-flash",
};

const DATED_SNAPSHOT = /-(\d{8}|\d{4}-\d{2}-\d{2})$/;

export function priceOf(model: string): ModelPrice | undefined {
  const name = model.trim().toLowerCase();
  const canonical = SLUG_ALIASES[name] ?? name;
  return PRICES[canonical] ?? PRICES[canonical.replace(DATED_SNAPSHOT, "")];
}

export type PricedRole = "maker" | "checker";

const OVERRIDE_PREFIX: Readonly<Record<PricedRole, string>> = {
  maker: "WINDKEEL_USD_PER_",
  checker: "WINDKEEL_CHECKER_USD_PER_",
};

function overrideOf(env: Record<string, string | undefined>, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function priceOverridesFromEnv(
  role: PricedRole,
  env: Record<string, string | undefined> = {},
): Partial<ModelPrice> {
  const prefix = OVERRIDE_PREFIX[role];
  const input = overrideOf(env, `${prefix}INPUT_TOKEN`);
  const output = overrideOf(env, `${prefix}OUTPUT_TOKEN`);
  const cachedInput = overrideOf(env, `${prefix}CACHED_INPUT_TOKEN`);
  const cacheWriteInput = overrideOf(env, `${prefix}CACHE_WRITE_INPUT_TOKEN`);
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cachedInput === undefined ? {} : { cachedInput }),
    ...(cacheWriteInput === undefined ? {} : { cacheWriteInput }),
  };
}

export function priceWithOverrides(
  model: string | null | undefined,
  overrides: Partial<ModelPrice> = {},
): ModelPrice | undefined {
  const catalog = model ? priceOf(model) : undefined;
  const input = overrides.input ?? catalog?.input;
  const output = overrides.output ?? catalog?.output;
  if (input === undefined || output === undefined) return undefined;
  const cachedInput = overrides.cachedInput ?? catalog?.cachedInput;
  const cacheWriteInput = overrides.cacheWriteInput ?? catalog?.cacheWriteInput;
  return {
    input,
    output,
    ...(cachedInput === undefined ? {} : { cachedInput }),
    ...(cacheWriteInput === undefined ? {} : { cacheWriteInput }),
  };
}

export function conservativePrice(env: Record<string, string | undefined> = {}): ModelPrice {
  const rates = Object.values(PRICES);
  return {
    input: overrideOf(env, "WINDKEEL_UNPRICED_USD_PER_INPUT_TOKEN") ?? Math.max(...rates.map((p) => p.input)),
    output: overrideOf(env, "WINDKEEL_UNPRICED_USD_PER_OUTPUT_TOKEN") ?? Math.max(...rates.map((p) => p.output)),
  };
}

export function resolvePrice(
  model: string,
  role: PricedRole,
  env: Record<string, string | undefined> = {},
): ModelPrice | undefined {
  return priceWithOverrides(model, priceOverridesFromEnv(role, env));
}
