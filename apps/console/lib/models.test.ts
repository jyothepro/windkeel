import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { callApi, refusal, type Method } from "./http.ts";
import { effectiveChoice, independenceProblem, modelsClient, vendorOf, type ModelPolicyEntry } from "./models.ts";

let seen: Array<{ method: string; url: string; body: unknown }> = [];
let answer: { status: number; body: unknown } = { status: 200, body: {} };
const realFetch = globalThis.fetch;

beforeEach(() => {
  seen = [];
  answer = { status: 200, body: {} };
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ method: String(init.method), url, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const client = modelsClient(async <T,>(method: Method, path: string, body?: unknown): Promise<T> => {
  const a = await callApi("https://api.test", "orq_test", method, path, body);
  if (!a.ok) throw refusal(a);
  return a.json as T;
});

const CRED = { id: "c-1", label: "prod", last4: "x9Qa", provider: "openai", status: "unverified" };

test("credentials: list, add, rotate, revoke and re-check, organization-scoped", async () => {
  answer.body = { items: [CRED], endCursor: null, hasNextPage: false };
  assert.equal((await client.listCredentials("org-1"))[0]!.label, "prod");
  assert.deepEqual(seen[0], { method: "GET", url: "https://api.test/v1/orgs/org-1/model-credentials", body: undefined });

  answer = { status: 201, body: { credential: CRED, validation: "started" } };
  const created = await client.createCredential("org-1", { provider: "openai", label: "prod", value: "sk-test-value" });
  assert.equal(seen[1]!.method, "POST");
  assert.deepEqual(seen[1]!.body, { provider: "openai", label: "prod", value: "sk-test-value" });
  assert.deepEqual(created, { credential: CRED, validation: "started" });

  answer = { status: 200, body: { credential: CRED, validation: "failed" } };
  await client.rotateCredential("org-1", "c 1", "sk-new");
  assert.deepEqual(seen[2], { method: "PUT", url: "https://api.test/v1/orgs/org-1/model-credentials/c%201", body: { value: "sk-new" } });

  await client.revokeCredential("org-1", "c-1");
  assert.equal(seen[3]!.method, "DELETE");
  answer = { status: 202, body: { accepted: true } };
  await client.validateCredential("org-1", "c-1");
  assert.equal(seen[4]!.url, "https://api.test/v1/orgs/org-1/model-credentials/c-1/validate");
});

test("an answer that carried more than the view still gives back only the credential and the check", async () => {
  answer = { status: 201, body: { credential: CRED, validation: "started", value: "sk-echoed" } };
  const created = await client.createCredential("org-1", { provider: "openai", label: "prod", value: "sk-echoed" });
  assert.ok(!JSON.stringify(created).includes("sk-echoed"));
});

test("policy: read a layer, set it, clear one role of it", async () => {
  answer.body = { repositoryId: null, items: [] };
  await client.getPolicy("org-1");
  await client.getPolicy("org-1", "repo-1");
  await client.setPolicy("org-1", "repo-1", { maker: { model: "gpt-5", provider: "openai", credentialId: null } });
  await client.clearPolicy("org-1", null, "checker");
  await client.clearPolicy("org-1", "repo-1");
  assert.deepEqual(
    seen.map((s) => `${s.method} ${s.url.replace("https://api.test/v1", "")}`),
    [
      "GET /orgs/org-1/model-policy",
      "GET /orgs/org-1/model-policy?repositoryId=repo-1",
      "PUT /orgs/org-1/model-policy?repositoryId=repo-1",
      "DELETE /orgs/org-1/model-policy?role=checker",
      "DELETE /orgs/org-1/model-policy?repositoryId=repo-1",
    ],
  );
  assert.deepEqual(seen[2]!.body, { maker: { model: "gpt-5", provider: "openai", credentialId: null } });
});

test("whose model: the router's model's maker, not the router; unknown names must be declared", () => {
  assert.deepEqual(vendorOf({ provider: "openai", model: "anything" }), { vendor: "openai" });
  assert.deepEqual(vendorOf({ provider: "openrouter", model: "anthropic/claude-sonnet-4.5" }), { vendor: "anthropic" });
  assert.deepEqual(vendorOf({ provider: "openrouter", model: "meta-llama/llama-3.3-70b" }), { vendor: "meta" });
  assert.deepEqual(vendorOf({ provider: "openai-compatible", model: "claude-sonnet-4-5" }), { vendor: "anthropic" });
  assert.deepEqual(vendorOf({ provider: "openai-compatible", model: "house-model", declaredVendor: "acme" }), { vendor: "acme" });
  assert.ok("problem" in vendorOf({ provider: "openai-compatible", model: "house-model" }));
  assert.ok("problem" in vendorOf({ provider: "openrouter", model: "someone/claude-distill" }), "an unknown prefix is unknown, not a family match");
  assert.ok("problem" in vendorOf({ provider: "openrouter", model: "anthropic/claude-opus-4.1", declaredVendor: "google" }), "a declaration can't relabel a known model");
});

test("independence is about vendors: Claude through OpenRouter can't check Claude's work", () => {
  const problem = independenceProblem({ provider: "anthropic", model: "claude-opus-4-1" }, { provider: "openrouter", model: "anthropic/claude-sonnet-4.5" });
  assert.match(problem ?? "", /both be anthropic's models/);
  assert.match(problem ?? "", /OpenRouter/);
  assert.equal(independenceProblem({ provider: "openai", model: "gpt-5" }, { provider: "openrouter", model: "anthropic/claude-sonnet-4.5" }), null);
  assert.equal(independenceProblem({ provider: "openai", model: "gpt-5" }, null), null, "nothing to compare yet");
});

test("a repository's layer is its own row, over the organization's", () => {
  const row = (repositoryId: string | null, role: "maker" | "checker", model: string) => ({ repositoryId, role, model }) as ModelPolicyEntry;
  const items = [row(null, "maker", "gpt-5"), row(null, "checker", "claude"), row("r1", "maker", "gpt-5-mini")];
  assert.equal(effectiveChoice(items, "maker", "r1").own?.model, "gpt-5-mini");
  assert.equal(effectiveChoice(items, "maker", "r1").inherited?.model, "gpt-5");
  assert.equal(effectiveChoice(items, "checker", "r1").own, null);
  assert.equal(effectiveChoice(items, "checker", null).own?.model, "claude");
});

test("presets: create, replace and delete under the model-policy surface, organization-scoped (#365)", async () => {
  const preset = { id: "pre 1", name: "Fast", harness: null, maker: { model: "gpt-5-mini", provider: "openai" }, checker: [{ model: "claude-opus-4-1", provider: "anthropic" }] };
  const input = { name: "Fast", maker: preset.maker, checker: preset.checker };
  answer = { status: 201, body: { preset } };
  assert.equal((await client.createPreset("org-1", input)).name, "Fast");
  assert.deepEqual(seen[0], { method: "POST", url: "https://api.test/v1/orgs/org-1/model-policy/presets", body: input });
  answer = { status: 200, body: { preset } };
  await client.updatePreset("org-1", "pre 1", input);
  assert.equal(seen[1]!.method, "PUT");
  assert.equal(seen[1]!.url, "https://api.test/v1/orgs/org-1/model-policy/presets/pre%201");
  await client.deletePreset("org-1", "pre 1");
  assert.equal(seen[2]!.method, "DELETE");
  answer = { status: 200, body: { repositoryId: null, items: [], presets: [preset], harnesses: [{ id: "codex", label: "OpenAI's Codex CLI", default: true }] } };
  const layer = await client.getPolicy("org-1");
  assert.equal(layer.presets?.[0]?.name, "Fast");
  assert.equal(layer.harnesses?.[0]?.id, "codex");
  answer = { status: 409, body: { error: "no checker model is independent of the maker (openai/gpt-5): …", code: "no_independent_checker" } };
  await assert.rejects(client.createPreset("org-1", input), (err: Error & { code?: string }) => err.code === "no_independent_checker");
});
