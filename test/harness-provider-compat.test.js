/**
 * ADR-0027 §4's harness ⇄ provider table, table-driven (#395 sub-task D), and the stage-time maker
 * route that applies it: Anthropic's API is refused for Codex only, the broker attaches the key as
 * the provider's own header, and a Windkeel-managed key is per provider.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PROVIDERS } from "@windkeel/verification/providers/catalog.js";
import { harnessProviderRefusal, harnessProviders } from "../dist/worker/descriptor.js";
import { makerRouteFor, MakerRouteError } from "../dist/factory/workflow/maker-route.js";

const TABLE = {
  codex: { openai: true, openrouter: true, "openai-compatible": true, anthropic: false },
  "claude-code": { openai: false, openrouter: false, "openai-compatible": false, anthropic: true },
  opencode: { openai: true, openrouter: true, "openai-compatible": true, anthropic: true },
};

for (const [harness, row] of Object.entries(TABLE)) {
  for (const [provider, allowed] of Object.entries(row)) {
    test(`§4: ${harness} + ${provider} is ${allowed ? "allowed" : "refused"}`, () => {
      assert.equal(harnessProviders(harness).includes(provider), allowed);
      const refusal = harnessProviderRefusal(harness, provider);
      if (allowed) assert.equal(refusal, null);
      else assert.match(refusal, new RegExp(`${harness} harness cannot call ${provider}`));
    });
  }
}

test("every catalog provider has a row, and an unknown harness is not judged here", () => {
  assert.deepEqual(Object.keys(TABLE.codex).sort(), Object.keys(PROVIDERS).sort());
  assert.equal(harnessProviderRefusal("not-a-harness", "anthropic"), null);
});

test("the catalog's auth header is the provider's: x-api-key for Anthropic, Authorization otherwise", () => {
  assert.equal(PROVIDERS.anthropic.authHeader, "x-api-key");
  for (const provider of ["openai", "openrouter", "openai-compatible"]) assert.equal(PROVIDERS[provider].authHeader, "Authorization");
});

// --- the stage-time route -------------------------------------------------------------------------

const config = {
  makerModel: "gpt-5-codex",
  modelApiDomain: "api.openai.com",
  modelKeyEnvVar: "OPENAI_API_KEY",
  makerKeyEnvVars: { anthropic: "WINDKEEL_TEST_ANTHROPIC_MAKER_KEY" },
};
const snapshot = (worker, maker) => ({
  version: 1,
  maker: { source: "organization", keySource: "orqon", worker, harness: { id: worker, version: "1.0.0" }, ...maker },
  checker: [],
  resolvedAt: "",
  policyIds: [],
});
const deps = (snap) => ({
  pool: null,
  config,
  workers: new Map([["codex", { name: "codex" }], ["claude-code", { name: "claude-code" }]]),
  runModels: async () => snap,
});
const claudeMaker = { provider: "anthropic", vendor: "anthropic", model: "claude-sonnet-4-5" };

test("claude-code + anthropic is routed to api.anthropic.com with the key brokered as x-api-key", async () => {
  const route = await makerRouteFor(deps(snapshot("claude-code", claudeMaker)), "run");
  assert.equal(route.workerType, "claude-code");
  assert.equal(route.route.modelApiDomain, "api.anthropic.com");
  assert.deepEqual(route.route.credentialRules, [
    { domain: "api.anthropic.com", header: "x-api-key", secretEnvVar: "WINDKEEL_TEST_ANTHROPIC_MAKER_KEY" },
  ]);
});

test("codex + anthropic is refused at the stage, naming Codex", async () => {
  await assert.rejects(makerRouteFor(deps(snapshot("codex", claudeMaker)), "run"), (error) => error instanceof MakerRouteError && /Codex cannot call/.test(error.message));
});

test("claude-code + openai is refused at the stage", async () => {
  const gpt = { provider: "openai", vendor: "openai", model: "gpt-5" };
  await assert.rejects(makerRouteFor(deps(snapshot("claude-code", gpt)), "run"), (error) => error instanceof MakerRouteError && /claude-code harness cannot call openai/.test(error.message));
});

test("a Windkeel-managed Anthropic maker with no operator key for Anthropic is refused, not sent", async () => {
  const noKey = { ...deps(snapshot("claude-code", claudeMaker)), config: { ...config, makerKeyEnvVars: {} } };
  await assert.rejects(makerRouteFor(noKey, "run"), /Windkeel-managed maker key is for api\.openai\.com/);
});

test("a codex maker on the operator's OpenAI key keeps the Authorization header", async () => {
  const route = await makerRouteFor(deps(snapshot("codex", { provider: "openai", vendor: "openai", model: "gpt-5" })), "run");
  assert.deepEqual(route.route.credentialRules, [{ domain: "api.openai.com", header: "Authorization", secretEnvVar: "OPENAI_API_KEY" }]);
});
