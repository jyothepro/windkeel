import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DeclaredVendorConflictError,
  PROVIDERS,
  UnknownModelVendorError,
  UnknownProviderError,
  conservativePrice,
  priceOf,
  resolvePrice,
  vendorOf,
} from "@windkeel/verification/providers/catalog.js";
import {
  NoIndependentProviderError,
  checkIndependence,
  makerIdentity,
  modelPolicyFromEnv,
  selectGateway,
} from "@windkeel/verification/providers/index.js";

/**
 * #319 / ADR-0026 §5: independence is a property of *whose model answers*, not of who is
 * called. These tables are the whole of the derivation — a router or slug missing from them is
 * an error, never a guess.
 */

const UNKNOWN_AUTHOR = { login: "someone", kind: "unknown" };

test("vendor derivation table", () => {
  const cases = [
    // First-party providers own every model they serve.
    ["openai", "gpt-5-codex", "openai"],
    ["openai", "o4-mini", "openai"],
    ["anthropic", "claude-sonnet-4-5", "anthropic"],
    // OpenRouter: the slug prefix decides.
    ["openrouter", "anthropic/claude-sonnet-4.5", "anthropic"],
    ["openrouter", "openai/gpt-5", "openai"],
    ["openrouter", "google/gemini-2.5-pro", "google"],
    ["openrouter", "meta-llama/llama-3.3-70b-instruct", "meta"],
    ["openrouter", "qwen/qwen3-coder", "alibaba"],
    ["openrouter", "deepseek/deepseek-chat-v3.1", "deepseek"],
    ["openrouter", "mistralai/devstral-medium", "mistral"],
    ["openrouter", "x-ai/grok-code-fast-1", "xai"],
    ["openrouter", "moonshotai/kimi-k2", "moonshot"],
    // Case is not identity.
    ["openrouter", "Anthropic/Claude-Opus-4.1", "anthropic"],
    // A compatible endpoint: slug prefix, else the bare name's family.
    ["openai-compatible", "meta-llama/Llama-3.1-70B-Instruct", "meta"],
    ["openai-compatible", "claude-sonnet-4-5", "anthropic"],
    ["openai-compatible", "gpt-4.1", "openai"],
    ["openai-compatible", "gemini-2.5-flash", "google"],
    ["openai-compatible", "llama3.1-70b", "meta"],
    ["openai-compatible", "qwen2.5-coder-32b", "alibaba"],
    ["openai-compatible", "deepseek-coder-v2", "deepseek"],
    ["openai-compatible", "codestral-latest", "mistral"],
  ];
  for (const [provider, model, vendor] of cases) {
    assert.equal(vendorOf({ provider, model }), vendor, `${provider} + ${model}`);
  }
});

test("an unknown model without a declared vendor is a typed error, not a guess", () => {
  assert.throws(
    () => vendorOf({ provider: "openai-compatible", model: "acme-coder-7b" }),
    UnknownModelVendorError,
  );
  // An unknown slug prefix is unknown — the remainder is not family-matched, so a fine-tune
  // named after Claude is not attributed to Anthropic.
  assert.throws(
    () => vendorOf({ provider: "openrouter", model: "someone/claude-distill" }),
    UnknownModelVendorError,
  );
  // OpenRouter's auto-router picks a vendor per request; nothing can be checked against it.
  assert.throws(() => vendorOf({ provider: "openrouter", model: "openrouter/auto" }), UnknownModelVendorError);
  assert.throws(() => vendorOf({ provider: "bedrock", model: "claude-sonnet-4-5" }), UnknownProviderError);
});

test("a declared vendor fills a gap but cannot relabel a known model", () => {
  assert.equal(
    vendorOf({ provider: "openai-compatible", model: "acme-coder-7b", declaredVendor: "acme" }),
    "acme",
  );
  assert.equal(
    vendorOf({ provider: "openrouter", model: "anthropic/claude-sonnet-4.5", declaredVendor: "anthropic" }),
    "anthropic",
  );
  assert.throws(
    () => vendorOf({ provider: "openrouter", model: "anthropic/claude-sonnet-4.5", declaredVendor: "google" }),
    DeclaredVendorConflictError,
  );
  assert.throws(
    () => vendorOf({ provider: "openai", model: "gpt-5", declaredVendor: "anthropic" }),
    DeclaredVendorConflictError,
  );
});

test("every known provider names its egress host and default base URL, except the open one", () => {
  assert.deepEqual(Object.keys(PROVIDERS).sort(), ["anthropic", "openai", "openai-compatible", "openrouter"]);
  assert.equal(PROVIDERS.openrouter.egressHost, "openrouter.ai");
  assert.equal(PROVIDERS.openrouter.defaultBaseUrl, "https://openrouter.ai/api/v1");
  assert.equal(PROVIDERS.openai.egressHost, "api.openai.com");
  assert.equal(PROVIDERS.anthropic.egressHost, "api.anthropic.com");
  // An open endpoint is wherever its base URL says; a default would be a guess.
  assert.equal(PROVIDERS["openai-compatible"].egressHost, undefined);
  assert.equal(PROVIDERS["openai-compatible"].defaultBaseUrl, undefined);
  for (const info of Object.values(PROVIDERS)) {
    if (info.defaultBaseUrl) assert.equal(new URL(info.defaultBaseUrl).host, info.egressHost);
  }
});

test("prices: the defaults are priced, slugs and snapshots alias, unknown is undefined", () => {
  // The two models Windkeel runs by default must never be unpriced.
  assert.deepEqual(priceOf("gpt-5-codex"), { input: 1.25e-6, output: 10e-6, cachedInput: 0.125e-6 });
  // ADR-0027 §8: Anthropic's 5-minute cache write is 1.25x base input.
  assert.deepEqual(priceOf("claude-sonnet-4-5"), { input: 3e-6, output: 15e-6, cachedInput: 0.3e-6, cacheWriteInput: 3.75e-6 });
  // #98: the production checker. It was recorded unpriced on every run until the Claude 5 family was added.
  const M = 1_000_000;
  assert.deepEqual(priceOf("claude-sonnet-5"), { input: 2 / M, output: 10 / M, cachedInput: 0.2 / M, cacheWriteInput: 2.5 / M });
  // Cache reads that are not 0.1x: Opus 5.5 publishes 0.05x, Fable 5.1 0.025x.
  assert.equal(priceOf("claude-opus-5-5")?.cachedInput, 0.2 / M);
  assert.equal(priceOf("claude-fable-5-1")?.cachedInput, 0.25 / M);
  assert.ok(priceOf("gpt-4.1"));

  assert.deepEqual(priceOf("anthropic/claude-sonnet-4.5"), priceOf("claude-sonnet-4-5"));
  assert.deepEqual(priceOf("openai/gpt-5"), priceOf("gpt-5"));
  assert.deepEqual(priceOf("claude-sonnet-4-5-20250929"), priceOf("claude-sonnet-4-5"));
  assert.deepEqual(priceOf("gpt-4.1-2025-04-14"), priceOf("gpt-4.1"));
  // A sibling is not its family: only a trailing date is stripped.
  assert.notDeepEqual(priceOf("gpt-5-mini"), priceOf("gpt-5"));

  // #242: unknown is not zero.
  assert.equal(priceOf("acme-coder-7b"), undefined);
  assert.equal(priceOf("someone/gpt-5"), undefined);
});

test("environment overrides win per field, for their own role only", () => {
  // Nothing set: the catalog.
  assert.deepEqual(resolvePrice("gpt-5-codex", "maker", {}), priceOf("gpt-5-codex"));

  // The maker's variables are the maker's; the checker's do not touch it.
  const env = {
    WINDKEEL_USD_PER_INPUT_TOKEN: "0.000002",
    WINDKEEL_CHECKER_USD_PER_OUTPUT_TOKEN: "0.00002",
  };
  assert.deepEqual(resolvePrice("gpt-5-codex", "maker", env), {
    input: 0.000002,
    output: 10e-6,
    cachedInput: 0.125e-6,
  });
  assert.deepEqual(resolvePrice("claude-sonnet-4-5", "checker", env), {
    input: 3e-6,
    output: 0.00002,
    cachedInput: 0.3e-6,
    cacheWriteInput: 3.75e-6,
  });

  // An unknown model is priced only when the environment gives both halves.
  assert.equal(resolvePrice("acme-coder-7b", "checker", {}), undefined);
  assert.equal(
    resolvePrice("acme-coder-7b", "checker", { WINDKEEL_CHECKER_USD_PER_INPUT_TOKEN: "0.000001" }),
    undefined,
  );
  assert.deepEqual(
    resolvePrice("acme-coder-7b", "checker", {
      WINDKEEL_CHECKER_USD_PER_INPUT_TOKEN: "0.000001",
      WINDKEEL_CHECKER_USD_PER_OUTPUT_TOKEN: "0.000004",
    }),
    { input: 0.000001, output: 0.000004 },
  );

  // Blank and nonsense are "not set", as they are in worker-config, not zero.
  assert.deepEqual(
    resolvePrice("gpt-5-codex", "maker", { WINDKEEL_USD_PER_INPUT_TOKEN: "", WINDKEEL_USD_PER_OUTPUT_TOKEN: "abc" }),
    priceOf("gpt-5-codex"),
  );
  // An explicit zero is an operator's statement and is honoured.
  assert.equal(resolvePrice("gpt-5-codex", "maker", { WINDKEEL_USD_PER_CACHED_INPUT_TOKEN: "0" }).cachedInput, 0);
});

// selectGateway / checkIndependence on derived vendors.

const endpoint = (fields) => ({ apiKey: "k", ...fields });

test("OpenRouter-served Claude is not independent of an Anthropic maker", () => {
  const openrouterClaude = endpoint({
    provider: "openrouter",
    vendor: "anthropic",
    model: "anthropic/claude-sonnet-4.5",
  });
  assert.throws(
    () => selectGateway({ endpoints: [openrouterClaude], maker: { vendor: "anthropic" } }, UNKNOWN_AUTHOR, "review"),
    NoIndependentProviderError,
  );
  // The legacy shape — the router's name in `vendor` — is caught the same way.
  const legacy = endpoint({ vendor: "openrouter", model: "anthropic/claude-sonnet-4.5", baseUrl: "https://openrouter.ai/api/v1" });
  assert.throws(
    () => selectGateway({ endpoints: [legacy], maker: { vendor: "anthropic" } }, UNKNOWN_AUTHOR, "review"),
    /only configured reviewer vendor \(anthropic\)/,
  );
});

test("a maker on a router is attributed to its model's vendor", () => {
  const maker = { provider: "openrouter", vendor: "openrouter", model: "openai/gpt-5-codex" };
  assert.equal(makerIdentity({ endpoints: [], maker }, UNKNOWN_AUTHOR).vendor, "openai");

  const gateway = selectGateway(
    {
      endpoints: [
        endpoint({ provider: "openrouter", vendor: "openai", model: "openai/gpt-5" }),
        endpoint({ provider: "openrouter", vendor: "anthropic", model: "anthropic/claude-sonnet-4.5" }),
      ],
      maker,
    },
    UNKNOWN_AUTHOR,
    "review",
  );
  // The gateway reports the derived vendor — what review evidence records — not "openrouter".
  assert.equal(gateway.vendor, "anthropic");
  assert.equal(gateway.model, "anthropic/claude-sonnet-4.5");
});

test("checkIndependence fails closed on what it cannot attribute", () => {
  const unknown = endpoint({ provider: "openai-compatible", vendor: "openai-compatible", model: "acme-coder-7b", baseUrl: "https://llm.example.com/v1" });
  const claude = endpoint({ vendor: "anthropic", model: "claude-sonnet-4-5" });

  // Known maker: an unattributable candidate is refused with the reason, the next one chosen.
  const result = checkIndependence({ vendor: "openai", model: "gpt-5-codex" }, [unknown, claude]);
  assert.equal(result.makerVendor, "openai");
  assert.deepEqual(result.independent.map((c) => c.vendor), ["anthropic"]);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /declare its vendor/);
  assert.equal(result.rejected[0].sameAsMaker, false);

  // Alone, it is run-fatal with that reason rather than the same-vendor sentence.
  assert.throws(
    () => selectGateway({ endpoints: [unknown], maker: { vendor: "openai" } }, UNKNOWN_AUTHOR, "review"),
    (error) => error instanceof NoIndependentProviderError && /declare its vendor/.test(error.message),
  );

  // A maker that cannot be attributed refuses every candidate.
  const blind = checkIndependence({ provider: "openrouter", model: "openrouter/auto" }, [claude]);
  assert.equal(blind.independent.length, 0);
  assert.match(blind.rejected[0].reason, /maker's vendor cannot be determined/);

  // A declared vendor makes it attributable.
  const declared = { ...unknown, vendor: "acme" };
  assert.deepEqual(
    checkIndependence({ vendor: "openai" }, [declared]).independent.map((c) => c.vendor),
    ["acme"],
  );

  // No maker at all (a human-authored PR in the CLI): nothing to be independent of.
  assert.equal(checkIndependence({}, [unknown]).independent.length, 1);
});

test("the provider picks the protocol and the default base URL", async () => {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const body = { choices: [{ finish_reason: "stop", message: { content: "{}" } }], stop_reason: "end_turn", content: [] };
    return { ok: true, status: 200, json: async () => body, text: async () => "" };
  };
  try {
    const maker = { vendor: "openai" };
    for (const e of [
      endpoint({ provider: "openrouter", vendor: "anthropic", model: "anthropic/claude-sonnet-4.5" }),
      endpoint({ provider: "anthropic", vendor: "anthropic", model: "claude-sonnet-4-5" }),
      endpoint({ vendor: "anthropic", model: "claude-sonnet-4-5" }),
    ]) {
      await selectGateway({ endpoints: [e], maker }, UNKNOWN_AUTHOR, "review").generate({ system: "s", user: "u" });
    }
    const compatible = selectGateway(
      { endpoints: [endpoint({ provider: "openai-compatible", vendor: "google", model: "gemini-2.5-pro" })], maker },
      UNKNOWN_AUTHOR,
      "review",
    );
    await assert.rejects(compatible.generate({ system: "s", user: "u" }), /no base URL/);
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(urls, [
    "https://openrouter.ai/api/v1/chat/completions",
    "https://api.anthropic.com/v1/messages",
    "https://api.anthropic.com/v1/messages",
  ]);
});

test("env-only policies select exactly as before", () => {
  // The factory's checker today: Anthropic key only, OpenAI maker.
  const policy = modelPolicyFromEnv({ ANTHROPIC_API_KEY: "a", WINDKEEL_MAKER_VENDOR: "openai" });
  const gateway = selectGateway(policy, UNKNOWN_AUTHOR, "review");
  assert.equal(gateway.vendor, "anthropic");
  assert.equal(gateway.model, "claude-sonnet-4-5");

  // A compatible endpoint with a declared vendor keeps it verbatim.
  const custom = modelPolicyFromEnv({
    WINDKEEL_MODEL_BASE_URL: "https://llm.example.com/v1",
    WINDKEEL_MODEL_API_KEY: "k",
    WINDKEEL_MODEL_NAME: "acme-coder-7b",
    WINDKEEL_MODEL_VENDOR: "acme",
    WINDKEEL_MAKER_VENDOR: "openai",
  });
  assert.equal(selectGateway(custom, UNKNOWN_AUTHOR, "review").vendor, "acme");
});

test("the conservative rate for unpriced calls is the catalog's highest, overridable (#324)", () => {
  assert.deepEqual(conservativePrice(), { input: 15e-6, output: 75e-6 });
  assert.deepEqual(
    conservativePrice({ WINDKEEL_UNPRICED_USD_PER_INPUT_TOKEN: "0.00002", WINDKEEL_UNPRICED_USD_PER_OUTPUT_TOKEN: "" }),
    { input: 0.00002, output: 75e-6 },
  );
});
