import { readFileSync } from "node:fs";
import type { Author } from "../evidence/format.js";
import { PROVIDERS, vendorOf } from "./catalog.js";
import type {
  MakerIdentity,
  ModelEndpoint,
  ModelGateway,
  ModelPolicy,
  ModelRequest,
  ModelResponse,
  ModelUsage,
  Purpose,
  Vendor,
} from "./types.js";

const AGENT_VENDORS: Record<string, Vendor> = {
  "openai-codex": "openai",
  "claude-code": "anthropic",
};

export function authorVendor(author: Author): Vendor | null {
  if (author.kind !== "agent" || !author.agent) return null;
  return AGENT_VENDORS[author.agent] ?? null;
}

const ROUTER_VENDOR_NAMES: ReadonlySet<string> = new Set(["openrouter", "openai-compatible"]);

export function derivedVendor(identity: {
  vendor?: Vendor | undefined;
  provider?: string | undefined;
  model?: string | undefined;
}): Vendor | undefined {
  const { vendor, provider, model = "" } = identity;
  if (provider) {
    const declared = vendor && !ROUTER_VENDOR_NAMES.has(vendor) ? vendor : undefined;
    return vendorOf({ provider, model, declaredVendor: declared });
  }
  if (vendor && ROUTER_VENDOR_NAMES.has(vendor)) return vendorOf({ provider: vendor, model });
  return vendor || undefined;
}

export function makerIdentity(policy: ModelPolicy, author: Author): MakerIdentity {
  if (policy.maker?.vendor || policy.maker?.model) {
    try {
      const vendor = derivedVendor(policy.maker);
      return vendor ? { ...policy.maker, vendor } : policy.maker;
    } catch {
      return policy.maker;
    }
  }
  const vendor = authorVendor(author);
  return vendor ? { vendor } : {};
}

export class NoIndependentProviderError extends Error {}

export interface IndependentEndpoint {
  endpoint: ModelEndpoint;
  vendor: Vendor;
}

export interface RejectedEndpoint {
  endpoint: ModelEndpoint;
  reason: string;
  sameAsMaker: boolean;
}

export interface IndependenceResult {
  makerVendor?: Vendor;
  independent: IndependentEndpoint[];
  rejected: RejectedEndpoint[];
}

const labelOf = (e: ModelEndpoint): string => `${e.provider ?? e.vendor}/${e.model}`;
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function checkIndependence(
  maker: MakerIdentity,
  checkerCandidates: readonly ModelEndpoint[],
): IndependenceResult {
  let makerVendor: Vendor | undefined;
  try {
    makerVendor = derivedVendor(maker);
  } catch (error) {
    return {
      independent: [],
      rejected: checkerCandidates.map((endpoint) => ({
        endpoint,
        reason: `the maker's vendor cannot be determined: ${reasonOf(error)}`,
        sameAsMaker: false,
      })),
    };
  }
  const makerKnown = makerVendor !== undefined || Boolean(maker.model);

  const independent: IndependentEndpoint[] = [];
  const rejected: RejectedEndpoint[] = [];
  for (const endpoint of checkerCandidates) {
    let vendor: Vendor | undefined;
    try {
      vendor = derivedVendor(endpoint);
    } catch (error) {
      if (makerKnown) {
        rejected.push({ endpoint, reason: `${labelOf(endpoint)}: ${reasonOf(error)}`, sameAsMaker: false });
        continue;
      }
      vendor = endpoint.vendor;
    }
    if (makerVendor !== undefined && vendor === makerVendor) {
      rejected.push({
        endpoint,
        reason: `${labelOf(endpoint)} serves ${vendor}'s model, and ${vendor} is the maker's vendor`,
        sameAsMaker: true,
      });
    } else if (maker.model && endpoint.model === maker.model) {
      rejected.push({
        endpoint,
        reason: `${labelOf(endpoint)} is the maker's own model`,
        sameAsMaker: true,
      });
    } else {
      independent.push({ endpoint, vendor: vendor ?? endpoint.vendor });
    }
  }
  return { ...(makerVendor === undefined ? {} : { makerVendor }), independent, rejected };
}

export function parseJsonResponse<T>(text: string): T {
  if (text.trim() === "") throw new Error("model returned no text at all");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("model returned no JSON object");
  return JSON.parse(text.slice(start, end + 1)) as T;
}

export class TruncatedResponseError extends Error {
  constructor(vendor: string, model: string, maxOutputTokens: number) {
    super(
      `${vendor}/${model} used its entire ${maxOutputTokens}-token output budget without ` +
        `finishing an answer. Raise it with WINDKEEL_MODEL_MAX_TOKENS, or give the model less to ` +
        `read — a reasoning model spends this budget thinking before it writes anything.`,
    );
    this.name = "TruncatedResponseError";
  }
}

export const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

function usageOf(input?: number, output?: number): { usage?: ModelUsage } {
  return typeof input === "number" && typeof output === "number"
    ? { usage: { inputTokens: input, outputTokens: output } }
    : {};
}

class FakeGateway implements ModelGateway {
  readonly vendor: Vendor = "fake";
  readonly model = "scripted-fake";
  constructor(private readonly scriptPath: string) {}
  async generate(): Promise<ModelResponse> {
    return { text: readFileSync(this.scriptPath, "utf8") };
  }
}

class AnthropicGateway implements ModelGateway {
  readonly model: string;
  constructor(
    private readonly endpoint: ModelEndpoint,
    readonly vendor: Vendor,
  ) {
    this.model = endpoint.model;
  }
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const maxOutputTokens = this.endpoint.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const base = (this.endpoint.baseUrl ?? PROVIDERS.anthropic.defaultBaseUrl!).replace(/\/$/, "");
    const response = await (this.endpoint.fetch ?? fetch)(`${base}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.endpoint.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxOutputTokens,
        system: request.system,
        messages: [{ role: "user", content: request.user }],
      }),
    });
    if (!response.ok) throw new Error(`anthropic: ${response.status} ${await response.text()}`);
    const body = (await response.json()) as {
      content: Array<{ type?: string; text?: string }>;
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    if (body.stop_reason === "max_tokens") {
      throw new TruncatedResponseError(this.vendor, this.model, maxOutputTokens);
    }
    return {
      text: body.content.map((c) => c.text ?? "").join(""),
      ...usageOf(body.usage?.input_tokens, body.usage?.output_tokens),
    };
  }
}

class OpenAiCompatibleGateway implements ModelGateway {
  readonly model: string;
  constructor(
    private readonly endpoint: ModelEndpoint,
    readonly vendor: Vendor,
  ) {
    this.model = endpoint.model;
  }
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const maxOutputTokens = this.endpoint.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const configured =
      this.endpoint.baseUrl ??
      (this.endpoint.provider
        ? PROVIDERS[this.endpoint.provider].defaultBaseUrl
        : PROVIDERS.openai.defaultBaseUrl);
    if (!configured) {
      throw new Error(`${this.endpoint.provider} endpoint for ${this.model} has no base URL`);
    }
    const base = configured.replace(/\/$/, "");
    const response = await (this.endpoint.fetch ?? fetch)(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.endpoint.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        response_format: { type: "json_object" },
        max_completion_tokens: maxOutputTokens,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
      }),
    });
    if (!response.ok) throw new Error(`openai: ${response.status} ${await response.text()}`);
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string | null }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    if (body.choices[0]?.finish_reason === "length") {
      throw new TruncatedResponseError(this.vendor, this.model, maxOutputTokens);
    }
    return {
      text: body.choices[0]?.message.content ?? "",
      ...usageOf(body.usage?.prompt_tokens, body.usage?.completion_tokens),
    };
  }
}

const gatewayFor = ({ endpoint, vendor }: IndependentEndpoint): ModelGateway => {
  const anthropic = endpoint.provider
    ? PROVIDERS[endpoint.provider].protocol === "anthropic"
    : endpoint.vendor === "anthropic" && !endpoint.baseUrl;
  return anthropic
    ? new AnthropicGateway(endpoint, vendor)
    : new OpenAiCompatibleGateway(endpoint, vendor);
};

export const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4.1",
};

export function selectGateway(
  policy: ModelPolicy,
  author: Author,
  purpose: Purpose,
): ModelGateway | null {
  const fake = policy.fakes?.[purpose];
  if (fake) return new FakeGateway(fake);

  if (!policy.endpoints.length) return null;

  const maker = makerIdentity(policy, author);
  const { makerVendor, independent, rejected } = checkIndependence(maker, policy.endpoints);
  if (!independent.length) {
    throw new NoIndependentProviderError(
      rejected.every((r) => r.sameAsMaker)
        ? `the only configured reviewer vendor (${makerVendor ?? maker.model}) is the vendor that authored this PR`
        : `no configured reviewer is independent of the maker: ${rejected.map((r) => r.reason).join("; ")}`,
    );
  }
  return gatewayFor(independent[0]!);
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function modelPolicyFromEnv(env: Record<string, string | undefined>): ModelPolicy {
  const endpoints: ModelEndpoint[] = [];
  const maxOutputTokens = positiveInteger(env["WINDKEEL_MODEL_MAX_TOKENS"]);
  if (env["ANTHROPIC_API_KEY"]) {
    endpoints.push({
      vendor: "anthropic",
      model: env["WINDKEEL_REVIEW_MODEL"] ?? DEFAULT_MODELS["anthropic"]!,
      apiKey: env["ANTHROPIC_API_KEY"],
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    });
  }
  if (env["OPENAI_API_KEY"]) {
    endpoints.push({
      vendor: "openai",
      model: env["WINDKEEL_REVIEW_MODEL"] ?? DEFAULT_MODELS["openai"]!,
      apiKey: env["OPENAI_API_KEY"],
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    });
  }
  if (env["WINDKEEL_MODEL_BASE_URL"] && env["WINDKEEL_MODEL_API_KEY"] && env["WINDKEEL_MODEL_NAME"]) {
    endpoints.push({
      vendor: env["WINDKEEL_MODEL_VENDOR"] ?? "openai-compatible",
      model: env["WINDKEEL_MODEL_NAME"],
      apiKey: env["WINDKEEL_MODEL_API_KEY"],
      baseUrl: env["WINDKEEL_MODEL_BASE_URL"],
    });
  }
  return {
    endpoints,
    fakes: { review: env["WINDKEEL_FAKE_REVIEWER"], mapping: env["WINDKEEL_FAKE_MAPPER"] },
    ...(env["WINDKEEL_MAKER_VENDOR"] ? { maker: { vendor: env["WINDKEEL_MAKER_VENDOR"] } } : {}),
  };
}
