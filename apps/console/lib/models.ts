import { orgPath, type Send } from "./automations.ts";

export type ModelProvider = "openai" | "anthropic" | "openrouter" | "openai-compatible";
export type ModelRole = "maker" | "checker";
export type KeySource = "orqon" | "customer";
export type CredentialStatus = "unverified" | "valid" | "invalid" | "revoked";

export const MODEL_PROVIDERS: readonly ModelProvider[] = ["openai", "anthropic", "openrouter", "openai-compatible"];
export const MODEL_ROLES: readonly ModelRole[] = ["maker", "checker"];

export const PROVIDER_LABEL: Record<ModelProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  "openai-compatible": "OpenAI-compatible endpoint",
};

export const ROLE_LABEL: Record<ModelRole, string> = { maker: "Maker", checker: "Checker" };

export const MODEL_SUGGESTIONS: Record<ModelProvider, readonly string[]> = {
  openai: ["gpt-5-codex", "gpt-5", "gpt-5-mini"],
  anthropic: ["claude-opus-4-1", "claude-sonnet-4-5"],
  openrouter: ["anthropic/claude-sonnet-4.5", "openai/gpt-5", "google/gemini-2.5-pro", "deepseek/deepseek-chat"],
  "openai-compatible": [],
};

export interface ModelCredential {
  id: string;
  provider: string;
  baseUrl: string | null;
  declaredVendor: string | null;
  label: string;
  last4: string;
  keypairId: string;
  status: CredentialStatus;
  statusReason: string | null;
  validatedAt: string | null;
  createdByPrincipalId: string | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export type ValidationStart = "started" | "unavailable" | "failed";

export interface ModelPolicyEntry {
  id: string;
  repositoryId: string | null;
  role: ModelRole;
  provider: string;
  model: string;
  credentialId: string | null;
  keySource: KeySource;
  declaredVendor: string | null;
  updatedByPrincipalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskModelChoice {
  model: string;
  provider?: string;
  credentialId?: string | null;
  declaredVendor?: string;
  harness?: string;
}

export interface TaskModels {
  maker?: TaskModelChoice;
  checker?: TaskModelChoice[];
}

export interface ModelPreset {
  id: string;
  name: string;
  harness: string | null;
  maker: TaskModelChoice;
  checker: TaskModelChoice[];
  createdByPrincipalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HarnessView {
  id: string;
  label: string;
  default: boolean;
}

export interface PresetInput {
  name: string;
  harness?: string | null;
  maker: TaskModelChoice;
  checker: TaskModelChoice[];
}

export interface ModelPolicyLayer {
  repositoryId: string | null;
  items: ModelPolicyEntry[];
  presets?: ModelPreset[];
  harnesses?: HarnessView[];
}

export interface PolicyChoice {
  model: string;
  provider?: string;
  credentialId: string | null;
  declaredVendor?: string;
}

export interface RunModelChoice {
  provider: string;
  vendor: string;
  model: string;
  baseUrl?: string;
  credentialId?: string;
  credentialLabel?: string;
  declaredVendor?: string;
  keySource: KeySource;
  source: "run" | "task" | "repository" | "organization" | "operator";
  worker?: string;
}

export interface RunModelConfig {
  version: 1;
  maker: RunModelChoice;
  checker: RunModelChoice[];
  resolvedAt: string;
  policyIds: string[];
}

const id = encodeURIComponent;

export function modelsClient(send: Send) {
  return {
    async listCredentials(orgId: string): Promise<ModelCredential[]> {
      return (await send<{ items: ModelCredential[] }>("GET", orgPath(orgId, "/model-credentials"))).items;
    },
    async createCredential(
      orgId: string,
      input: { provider: string; label: string; value: string; baseUrl?: string; declaredVendor?: string },
    ): Promise<{ credential: ModelCredential; validation: ValidationStart }> {
      const { credential, validation } = await send<{ credential: ModelCredential; validation: ValidationStart }>(
        "POST",
        orgPath(orgId, "/model-credentials"),
        input,
      );
      return { credential, validation };
    },
    async rotateCredential(orgId: string, credentialId: string, value: string): Promise<{ credential: ModelCredential; validation: ValidationStart }> {
      const { credential, validation } = await send<{ credential: ModelCredential; validation: ValidationStart }>(
        "PUT",
        orgPath(orgId, `/model-credentials/${id(credentialId)}`),
        { value },
      );
      return { credential, validation };
    },
    async revokeCredential(orgId: string, credentialId: string): Promise<void> {
      await send("DELETE", orgPath(orgId, `/model-credentials/${id(credentialId)}`));
    },
    async validateCredential(orgId: string, credentialId: string): Promise<void> {
      await send("POST", orgPath(orgId, `/model-credentials/${id(credentialId)}/validate`));
    },
    async getPolicy(orgId: string, repositoryId: string | null = null): Promise<ModelPolicyLayer> {
      const q = repositoryId ? `?repositoryId=${id(repositoryId)}` : "";
      return send("GET", orgPath(orgId, `/model-policy${q}`));
    },
    async setPolicy(orgId: string, repositoryId: string | null, body: Partial<Record<ModelRole, PolicyChoice>>): Promise<ModelPolicyLayer> {
      const q = repositoryId ? `?repositoryId=${id(repositoryId)}` : "";
      return send("PUT", orgPath(orgId, `/model-policy${q}`), body);
    },
    async createPreset(orgId: string, input: PresetInput): Promise<ModelPreset> {
      return (await send<{ preset: ModelPreset }>("POST", orgPath(orgId, "/model-policy/presets"), input)).preset;
    },
    async updatePreset(orgId: string, presetId: string, input: PresetInput): Promise<ModelPreset> {
      return (await send<{ preset: ModelPreset }>("PUT", orgPath(orgId, `/model-policy/presets/${id(presetId)}`), input)).preset;
    },
    async deletePreset(orgId: string, presetId: string): Promise<void> {
      await send("DELETE", orgPath(orgId, `/model-policy/presets/${id(presetId)}`));
    },
    async clearPolicy(orgId: string, repositoryId: string | null, role?: ModelRole): Promise<void> {
      const q = new URLSearchParams();
      if (repositoryId) q.set("repositoryId", repositoryId);
      if (role) q.set("role", role);
      const s = q.toString();
      await send("DELETE", orgPath(orgId, `/model-policy${s ? `?${s}` : ""}`));
    },
  };
}

export type ModelsApi = ReturnType<typeof modelsClient>;

const FIRST_PARTY: Partial<Record<string, string>> = { openai: "openai", anthropic: "anthropic" };

const SLUG_PREFIX_VENDORS: Readonly<Record<string, string>> = {
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

const MODEL_FAMILY_VENDORS: ReadonlyArray<readonly [RegExp, string]> = [
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

function vendorFromModelName(model: string): string | undefined {
  const name = model.trim().toLowerCase();
  const slash = name.indexOf("/");
  if (slash !== -1) return SLUG_PREFIX_VENDORS[name.slice(0, slash)];
  return MODEL_FAMILY_VENDORS.find(([pattern]) => pattern.test(name))?.[1];
}

export function vendorOf(choice: { provider: string; model: string; declaredVendor?: string | null }): { vendor: string } | { problem: string } {
  if (!(MODEL_PROVIDERS as readonly string[]).includes(choice.provider)) return { problem: `${choice.provider} isn't a provider Windkeel knows.` };
  const declared = choice.declaredVendor?.trim() || undefined;
  const derived = FIRST_PARTY[choice.provider] ?? vendorFromModelName(choice.model);
  if (derived) {
    if (declared && declared !== derived) return { problem: `${choice.model} is ${derived}'s model, but its vendor was declared as ${declared}.` };
    return { vendor: derived };
  }
  if (declared) return { vendor: declared };
  return { problem: `Windkeel can't tell whose model “${choice.model}” is. Declare its vendor (the company that made it).` };
}

export function independenceProblem(
  maker: { provider: string; model: string; declaredVendor?: string | null } | null,
  checker: { provider: string; model: string; declaredVendor?: string | null } | null,
): string | null {
  if (!maker?.model || !checker?.model) return null;
  const m = vendorOf(maker);
  const c = vendorOf(checker);
  if (!("vendor" in m) || !("vendor" in c)) return null;
  if (m.vendor !== c.vendor) return null;
  return (
    `The maker and the checker would both be ${m.vendor}'s models. Windkeel's verdict rests on an independent checker — ` +
    `another vendor's model reviewing the work — so a run with this pair fails at intake instead of grading its own work. ` +
    `Choose a checker from another vendor${maker.provider === "openrouter" || checker.provider === "openrouter" ? " (through OpenRouter it's the model's maker that counts, not the router)" : ""}.`
  );
}

export function noIndependentReason(
  maker: { provider: string; model: string; declaredVendor?: string | null },
  checkers: ReadonlyArray<{ provider: string; model: string; declaredVendor?: string | null }>,
): string | null {
  if (checkers.length === 0) return null;
  const m = vendorOf(maker);
  if (!("vendor" in m)) return null;
  const rejected: string[] = [];
  for (const checker of checkers) {
    const c = vendorOf(checker);
    if (!("vendor" in c)) return null;
    if (c.vendor === m.vendor) rejected.push(`${checker.provider}/${checker.model} serves ${c.vendor}'s model, and ${m.vendor} is the maker's vendor`);
    else if (checker.model === maker.model) rejected.push(`${checker.provider}/${checker.model} is the maker's own model`);
    else return null;
  }
  return `no checker model is independent of the maker (${m.vendor}/${maker.model}): ${rejected.join("; ")} (ADR-0010, ADR-0026 §5)`;
}

export function harnessName(id: string | undefined, harnesses: readonly HarnessView[] = []): string {
  if (!id) return "the default agent";
  return harnesses.find((h) => h.id === id)?.label ?? HARNESS_LABEL[id] ?? id;
}

export const HARNESS_LABEL: Readonly<Record<string, string>> = {
  codex: "OpenAI's Codex CLI",
  "claude-code": "Claude Code",
  opencode: "OpenCode",
  fake: "a scripted agent",
};

const ROUTER_VENDORS: ReadonlySet<string> = new Set(["openrouter", "openai-compatible"]);

export function selectedCheckerIndex(config: RunModelConfig): number {
  const { maker } = config;
  let makerVendor: string | undefined = maker.vendor || undefined;
  if (makerVendor && ROUTER_VENDORS.has(makerVendor)) {
    const derived = vendorOf({ provider: makerVendor, model: maker.model });
    if (!("vendor" in derived)) return -1;
    makerVendor = derived.vendor;
  }
  const makerKnown = makerVendor !== undefined || Boolean(maker.model);
  for (const [index, c] of config.checker.entries()) {
    const derived = vendorOf({ provider: c.provider, model: c.model, declaredVendor: c.vendor && !ROUTER_VENDORS.has(c.vendor) ? c.vendor : undefined });
    let vendor: string | undefined;
    if ("vendor" in derived) vendor = derived.vendor;
    else if (makerKnown) continue;
    else vendor = c.vendor;
    if (makerVendor !== undefined && vendor === makerVendor) continue;
    if (maker.model && c.model === maker.model) continue;
    return index;
  }
  return -1;
}

export function snapshotLine(config: RunModelConfig | null | undefined): { text: string; title: string } | null {
  if (!config) return null;
  const chosen = selectedCheckerIndex(config);
  const checker = chosen >= 0 ? config.checker[chosen] : undefined;
  const keys = new Set([config.maker, ...(checker ? [checker] : [])].map((c) => c.keySource));
  const keyText = keys.size > 1 ? "mixed keys" : keys.has("customer") ? "your keys" : "Windkeel-managed keys";
  const parts = [
    harnessName(config.maker.worker),
    config.maker.model,
    checker ? `checked by ${checker.model}` : config.checker.length ? "no independent checker" : "no checker",
    keyText,
  ];
  const keyOf = (c: RunModelChoice) => (c.keySource === "customer" ? `key “${c.credentialLabel ?? c.credentialId ?? "?"}”` : "Windkeel-managed key");
  const title =
    `Frozen when the run started: maker ${config.maker.vendor}'s ${config.maker.model} via ${providerName(config.maker.provider, config.maker.baseUrl)} (${keyOf(config.maker)})` +
    (checker ? `; checker ${checker.vendor}'s ${checker.model} via ${providerName(checker.provider, checker.baseUrl)} (${keyOf(checker)})` : "") +
    ". Changing models is a new run.";
  return { text: parts.join(" · "), title };
}

export function providerName(provider: string, baseUrl?: string | null): string {
  const label = PROVIDER_LABEL[provider as ModelProvider] ?? provider;
  if (provider !== "openai-compatible" || !baseUrl) return label;
  try {
    return `${label} · ${new URL(baseUrl).host}`;
  } catch {
    return label;
  }
}

export function effectiveChoice(items: readonly ModelPolicyEntry[], role: ModelRole, repositoryId: string | null) {
  const own = repositoryId ? items.find((p) => p.role === role && p.repositoryId === repositoryId) ?? null : null;
  const org = items.find((p) => p.role === role && p.repositoryId === null) ?? null;
  return { own: repositoryId ? own : org, inherited: repositoryId ? org : null };
}

export const STATUS_WORDS: Record<CredentialStatus, { label: string; intent: "neutral" | "success" | "danger" | "warning" }> = {
  unverified: { label: "unverified", intent: "warning" },
  valid: { label: "valid", intent: "success" },
  invalid: { label: "invalid", intent: "danger" },
  revoked: { label: "revoked", intent: "neutral" },
};
