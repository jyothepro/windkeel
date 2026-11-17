import { test } from "node:test";
import assert from "node:assert/strict";
import * as actions from "./model-actions.ts";
import { ApiError } from "./http.ts";
import type { ModelCredential, ModelsApi } from "./models.ts";

const KEY = "sk-proj-Zx9QqRt7vB2mN4pL8sW1yH6jD3fA5gC0";

const credential = (fields: Partial<ModelCredential> = {}): ModelCredential => ({
  id: "11111111-1111-4111-8111-111111111111",
  provider: "openrouter",
  baseUrl: null,
  declaredVendor: null,
  label: "router",
  last4: KEY.slice(-4),
  keypairId: "kp",
  status: "unverified",
  statusReason: null,
  validatedAt: null,
  createdByPrincipalId: null,
  createdAt: "",
  updatedAt: "",
  revokedAt: null,
  ...fields,
});

function fakeApi(overrides: Partial<Record<keyof ModelsApi, (...args: unknown[]) => unknown>> = {}) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const defaults: Record<string, (...args: unknown[]) => unknown> = {
    createCredential: () => ({ credential: credential(), validation: "started" }),
    rotateCredential: () => ({ credential: credential(), validation: "failed" }),
    setPolicy: () => ({ repositoryId: null, items: [] }),
  };
  const api = new Proxy({} as ModelsApi, {
    get: (_t, name: string) =>
      async (...args: unknown[]) => {
        calls.push({ name, args });
        const fn = overrides[name as keyof ModelsApi] ?? defaults[name];
        return fn ? fn(...args) : undefined;
      },
  });
  return { api, calls };
}

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};

test("adding a key sends it once and answers with the label, last four and the check — never the key", async () => {
  const { api, calls } = fakeApi();
  const res = await actions.addCredential(api, "org-1", form({ provider: "openrouter", label: "router", value: ` ${KEY}\n` }));
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0], { name: "createCredential", args: ["org-1", { provider: "openrouter", label: "router", value: KEY }] });
  assert.ok(!JSON.stringify(res).includes(KEY), "the key is in no answer");
  assert.ok(!("secret" in res), "nothing is shown once: there is nothing to show");
  assert.match(res.ok ? (res.message ?? "") : "", /“router” \(…5gC0\)\. Windkeel is checking it/);
});

test("a key form is checked before the API is asked", async () => {
  const { api, calls } = fakeApi();
  const refused = async (fields: Record<string, string>) => {
    const res = await actions.addCredential(api, "org-1", form(fields));
    assert.equal(res.ok, false);
    return res.ok ? "" : res.message;
  };
  assert.match(await refused({ provider: "bedrock", label: "x", value: KEY }), /provider/);
  assert.match(await refused({ provider: "openai", label: "", value: KEY }), /Name it/);
  assert.match(await refused({ provider: "openai", label: "x", value: "" }), /Paste the key/);
  assert.match(await refused({ provider: "openai", label: "x", value: "sk two words" }), /space or a line break/);
  assert.match(await refused({ provider: "openai-compatible", label: "x", value: KEY }), /base URL/);
  assert.match(await refused({ provider: "openai-compatible", label: "x", value: KEY, baseUrl: "http://10.0.0.1/v1" }), /https/);
  assert.equal(calls.length, 0);
});

test("a compatible endpoint takes its URL and declared vendor; a refusal comes back in words", async () => {
  const { api, calls } = fakeApi({
    createCredential: () => {
      throw new ApiError(409, "label_taken", 'a credential labelled "vllm" already exists');
    },
  });
  const res = await actions.addCredential(api, "org-1", form({ provider: "openai-compatible", label: "vllm", value: KEY, baseUrl: "https://llm.example.com/v1", declaredVendor: "Meta" }));
  assert.deepEqual((calls[0]!.args[1] as Record<string, unknown>)["baseUrl"], "https://llm.example.com/v1");
  assert.deepEqual((calls[0]!.args[1] as Record<string, unknown>)["declaredVendor"], "meta");
  assert.deepEqual(res, { ok: false, message: "A key with that label already exists here. Rotate it, or pick another label." });
});

test("rotating says the check didn't start when it didn't, and still not the key", async () => {
  const { api, calls } = fakeApi();
  const res = await actions.rotateCredential(api, "org-1", "cred-1", form({ value: KEY }));
  assert.deepEqual(calls[0]!.args, ["org-1", "cred-1", KEY]);
  assert.match(res.ok ? (res.message ?? "") : "", /couldn't be started.*Check again/);
  assert.ok(!JSON.stringify(res).includes(KEY));
});

test("the policy form: a credential decides the provider, blank roles are left alone", () => {
  const creds = [credential()];
  const read = actions.readPolicyForm(
    form({ "maker.key": "orqon", "maker.provider": "openai", "maker.model": "gpt-5-codex", "checker.key": creds[0]!.id, "checker.model": "anthropic/claude-sonnet-4.5" }),
    creds,
  );
  assert.ok("body" in read);
  assert.deepEqual(read.body, {
    maker: { model: "gpt-5-codex", provider: "openai", credentialId: null },
    checker: { model: "anthropic/claude-sonnet-4.5", credentialId: creds[0]!.id },
  });
  const one = actions.readPolicyForm(form({ "maker.key": "orqon", "maker.provider": "openai", "maker.model": "gpt-5", "checker.model": "" }), creds);
  assert.ok("body" in one && one.body.checker === undefined);
  const none = actions.readPolicyForm(form({}), creds);
  assert.ok("problem" in none);
  const revoked = actions.readPolicyForm(form({ "maker.key": "gone", "maker.model": "gpt-5" }), creds);
  assert.match("problem" in revoked ? revoked.problem : "", /gone/);
  const compatible = actions.readPolicyForm(form({ "maker.key": "orqon", "maker.provider": "openai-compatible", "maker.model": "x" }), creds);
  assert.match("problem" in compatible ? compatible.problem : "", /needs your own key/);
});

test("saving a pair that isn't independent saves, and says why it will fail at intake", async () => {
  const creds = [credential()];
  const { api, calls } = fakeApi();
  const res = await actions.savePolicy(
    api,
    "org-1",
    null,
    form({ "maker.key": "orqon", "maker.provider": "anthropic", "maker.model": "claude-opus-4-1", "checker.key": creds[0]!.id, "checker.model": "anthropic/claude-sonnet-4.5" }),
    creds,
  );
  assert.equal(calls[0]!.name, "setPolicy");
  assert.equal(res.ok, true);
  assert.match(res.ok ? (res.message ?? "") : "", /^Saved — but the maker and the checker would both be anthropic's models/);

  const override = await actions.savePolicy(api, "org-1", "repo-1", form({ "maker.key": "orqon", "maker.provider": "openai", "maker.model": "gpt-5" }), creds, {
    checker: { provider: "openrouter", model: "openai/gpt-5" },
  });
  assert.match(override.ok ? (override.message ?? "") : "", /both be openai's/);
  assert.deepEqual(calls[1]!.args.slice(0, 2), ["org-1", "repo-1"]);
});

test("clearing names a role or is refused", async () => {
  const { api, calls } = fakeApi();
  assert.deepEqual(await actions.clearPolicy(api, "org-1", "repo-1", "checker"), { ok: true });
  assert.deepEqual(calls[0]!.args, ["org-1", "repo-1", "checker"]);
  assert.equal((await actions.clearPolicy(api, "org-1", null, "reviewer")).ok, false);
});

const CODEX = [{ id: "codex", label: "OpenAI's Codex CLI", default: true }];
const TWO = [...CODEX, { id: "claude-code", label: "Claude Code", default: false }];

test("a preset form becomes a whole pairing; the default agent isn't sent", async () => {
  const { api, calls } = fakeApi({ createPreset: () => ({ name: "Fast" }) });
  const res = await actions.savePreset(
    api,
    "org-1",
    null,
    form({ name: "  Fast  ", harness: "codex", "maker.key": "orqon", "maker.provider": "openai", "maker.model": "gpt-5-mini", "checker.key": "orqon", "checker.provider": "anthropic", "checker.model": "claude-opus-4-1" }),
    [],
    TWO,
  );
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0], {
    name: "createPreset",
    args: ["org-1", { name: "Fast", harness: null, maker: { model: "gpt-5-mini", provider: "openai", credentialId: null }, checker: [{ model: "claude-opus-4-1", provider: "anthropic", credentialId: null }] }],
  });
  assert.match(res.ok ? (res.message ?? "") : "", /offered first in the composer/);
});

test("a preset is refused before the API when it's half a pair, nameless, or not independent", async () => {
  const { api, calls } = fakeApi();
  const refused = async (fields: Record<string, string>, harnesses = CODEX) => {
    const res = await actions.savePreset(api, "org-1", null, form(fields), [credential()], harnesses);
    assert.equal(res.ok, false);
    return res.ok ? "" : res.message;
  };
  const maker = { "maker.key": "orqon", "maker.provider": "openai", "maker.model": "gpt-5" };
  assert.match(await refused({ name: "", ...maker }), /Name it/);
  assert.match(await refused({ name: "Half", ...maker }), /both a maker and a checker/);
  assert.match(await refused({ name: "X", harness: "opencode", ...maker }), /isn't enabled/);
  assert.match(
    await refused({ name: "Mirror", ...maker, "checker.key": credential().id, "checker.model": "openai/gpt-5-mini" }),
    /both be openai's models/,
  );
  assert.equal(calls.length, 0);
});

test("editing a preset keeps its fallback checkers; the form edits only the first", async () => {
  const { api, calls } = fakeApi({ updatePreset: () => ({ name: "Thorough" }), createPreset: () => ({ name: "Thorough" }) });
  const existing = {
    checker: [
      { model: "claude-opus-4-1", provider: "anthropic", credentialId: null },
      { model: "google/gemini-2.5-pro", credentialId: "33333333-3333-4333-8333-333333333333" },
      { model: "deepseek/deepseek-chat", credentialId: "33333333-3333-4333-8333-333333333333" },
    ],
  };
  const fields = { name: "Thorough", "maker.key": "orqon", "maker.provider": "openai", "maker.model": "gpt-5", "checker.key": "orqon", "checker.provider": "anthropic", "checker.model": "claude-sonnet-4-5" };
  assert.equal((await actions.savePreset(api, "org-1", "pre-1", form(fields), [], CODEX, existing)).ok, true);
  assert.deepEqual((calls[0]!.args[2] as { checker: unknown[] }).checker, [
    { model: "claude-sonnet-4-5", provider: "anthropic", credentialId: null },
    existing.checker[1],
    existing.checker[2],
  ]);
  await actions.savePreset(api, "org-1", null, form(fields), [], CODEX, existing);
  assert.equal((calls[1]!.args[1] as { checker: unknown[] }).checker.length, 1);
  assert.match(actions.fallbackNote(existing), /2 fallback checkers \(google\/gemini-2\.5-pro, then deepseek\/deepseek-chat\).*keeps them unchanged/);
  assert.match(actions.fallbackNote({ checker: existing.checker.slice(0, 2) }), /1 fallback checker \(google\/gemini-2\.5-pro\).*keeps it unchanged/);
});

test("editing replaces the preset; the API's independence refusal comes back in words", async () => {
  const { api, calls } = fakeApi({
    updatePreset: () => {
      throw new ApiError(409, "no_independent_checker", "no checker model is independent of the maker (openai/gpt-5): x");
    },
  });
  const fields = { name: "Fast", "maker.key": "orqon", "maker.provider": "openai", "maker.model": "gpt-5", "checker.key": "orqon", "checker.provider": "anthropic", "checker.model": "claude-opus-4-1" };
  const res = await actions.savePreset(api, "org-1", "pre-1", form(fields), [], CODEX);
  assert.equal(calls[0]!.name, "updatePreset");
  assert.equal(calls[0]!.args[1], "pre-1");
  assert.equal(res.ok, false);
  assert.match(res.ok ? "" : res.message, /no checker model is independent/);
  assert.equal((await actions.deletePreset(fakeApi().api, "org-1", "pre-1")).ok, true);
});
