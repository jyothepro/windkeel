import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPicker,
  checkerOptions,
  defaultLabel,
  makerOptions,
  modelsFromForm,
  pairReason,
  rerunDefaultProblem,
  showsAgentPicker,
  TASK_MODELS,
} from "./model-picker.ts";
import { noIndependentReason, selectedCheckerIndex, snapshotLine, type ModelCredential, type ModelPolicyLayer, type RunModelConfig } from "./models.ts";

const ROUTER = "11111111-1111-4111-8111-111111111111";
const OPENAI = "22222222-2222-4222-8222-222222222222";

const credential = (id: string, provider: string, label: string, status: ModelCredential["status"] = "valid"): ModelCredential => ({
  id,
  provider,
  baseUrl: null,
  declaredVendor: null,
  label,
  last4: "abcd",
  keypairId: "kp",
  status,
  statusReason: null,
  validatedAt: null,
  createdByPrincipalId: null,
  createdAt: "",
  updatedAt: "",
  revokedAt: null,
});

const row = (role: "maker" | "checker", provider: string, model: string, credentialId: string | null = null) => ({
  id: `p-${role}`,
  repositoryId: null,
  role,
  provider,
  model,
  credentialId,
  keySource: credentialId ? ("customer" as const) : ("orqon" as const),
  declaredVendor: null,
  updatedByPrincipalId: null,
  createdAt: "",
  updatedAt: "",
});

const policy = (fields: Partial<ModelPolicyLayer> = {}): ModelPolicyLayer => ({
  repositoryId: null,
  items: [row("maker", "openai", "gpt-5-codex"), row("checker", "anthropic", "claude-sonnet-4-5")],
  presets: [
    {
      id: "pre-fast",
      name: "Fast",
      harness: null,
      maker: { model: "gpt-5-mini", provider: "openai", credentialId: null },
      checker: [{ model: "anthropic/claude-sonnet-4.5", credentialId: ROUTER }],
      createdByPrincipalId: null,
      createdAt: "",
      updatedAt: "",
    },
  ],
  harnesses: [{ id: "codex", label: "OpenAI's Codex CLI", default: true }],
  ...fields,
});

const creds = [credential(ROUTER, "openrouter", "router"), credential(OPENAI, "openai", "prod")];

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

test("the defaults are the organization's rows, labelled (organization default)", () => {
  const picker = buildPicker(policy(), creds);
  assert.equal(picker.defaultMaker.label, "gpt-5-codex (organization default)");
  assert.equal(picker.defaultChecker.label, "claude-sonnet-4-5 (organization default)");
  assert.equal(defaultLabel(picker), "gpt-5-codex · checked by claude-sonnet-4-5 (organization default)");
  const bare = buildPicker(policy({ items: [] }), []);
  assert.equal(bare.defaultMaker.label, "Windkeel's default model (organization default)");
  assert.equal(bare.defaultMaker.choice, null);
});

test("presets come first, with their pairing; a preset that has gone dependent or lost its key is disabled", () => {
  const picker = buildPicker(policy(), creds);
  assert.deepEqual(picker.presets.map((p) => [p.name, p.label, p.disabledReason]), [
    ["Fast", "Fast — gpt-5-mini · checked by anthropic/claude-sonnet-4.5", null],
  ]);
  const dependent = buildPicker(
    policy({ presets: [{ ...policy().presets![0]!, checker: [{ model: "openai/gpt-5", credentialId: ROUTER }] }] }),
    creds,
  );
  assert.match(dependent.presets[0]!.disabledReason!, /^no checker model is independent of the maker \(openai\/gpt-5-mini\)/);
  const revoked = buildPicker(policy(), [credential(OPENAI, "openai", "prod")]);
  assert.match(revoked.presets[0]!.disabledReason!, /revoked/);
  const otherAgent = buildPicker(policy({ presets: [{ ...policy().presets![0]!, harness: "claude-code" }] }), creds);
  assert.match(otherAgent.presets[0]!.disabledReason!, /isn't enabled on this deployment/);
});

test("raw makers are what Codex can call; raw checkers include each live key's models", () => {
  const picker = buildPicker(policy(), [...creds, credential("33333333-3333-4333-8333-333333333333", "openrouter", "dead", "invalid")]);
  assert.ok(picker.makers.some((o) => o.key === "orqon|openai|gpt-5" && o.label === "gpt-5 · Windkeel-managed"));
  assert.ok(picker.makers.some((o) => o.key === `${ROUTER}|openrouter|anthropic/claude-sonnet-4.5`));
  assert.ok(!picker.makers.some((o) => o.judged.provider === "anthropic"), "Codex speaks OpenAI's formats");
  assert.ok(picker.checkers.some((o) => o.key === "orqon|anthropic|claude-opus-4-1"));
  assert.ok(!picker.makers.some((o) => o.label.includes("dead")), "an invalid key is not offered");
});

test("a maker that leaves no independent checker is disabled, with NoIndependentProviderError's reason", () => {
  const picker = buildPicker(policy(), creds);
  const claude = makerOptions(picker, "").find((o) => o.key === `${ROUTER}|openrouter|anthropic/claude-sonnet-4.5`)!;
  assert.equal(
    claude.disabledReason,
    "no checker model is independent of the maker (anthropic/anthropic/claude-sonnet-4.5): anthropic/claude-sonnet-4-5 serves anthropic's model, and anthropic is the maker's vendor (ADR-0010, ADR-0026 §5)",
  );
  assert.equal(makerOptions(picker, "").find((o) => o.key === "orqon|openai|gpt-5")!.disabledReason, null);
  const openaiChecker = `${OPENAI}|openai|gpt-5`;
  assert.equal(makerOptions(picker, openaiChecker).find((o) => o.key === claude.key)!.disabledReason, null);
  assert.match(makerOptions(picker, openaiChecker).find((o) => o.key === "orqon|openai|gpt-5-mini")!.disabledReason!, /openai is the maker's vendor/);
  assert.match(checkerOptions(picker, "").find((o) => o.key === openaiChecker)!.disabledReason!, /no checker model is independent/);
  assert.equal(pairReason(buildPicker(policy({ items: [] }), creds), `${ROUTER}|openrouter|anthropic/claude-sonnet-4.5`, ""), null);
});

test("the Agent picker appears only with more than one harness", () => {
  assert.equal(showsAgentPicker(buildPicker(policy(), creds)), false);
  assert.equal(showsAgentPicker(buildPicker(policy({ harnesses: undefined }), creds)), false);
  const two = buildPicker(policy({ harnesses: [{ id: "codex", label: "OpenAI's Codex CLI", default: true }, { id: "claude-code", label: "Claude Code", default: false }] }), creds);
  assert.equal(showsAgentPicker(two), true);
});

test("the form becomes models: nothing for the default, a preset's choices, More's pair, the agent", () => {
  const picker = buildPicker(policy(), creds);
  assert.deepEqual(modelsFromForm(form({ model: "" }), picker), { models: null });
  assert.deepEqual(modelsFromForm(form({ model: "" }), null), { models: null });
  assert.deepEqual(modelsFromForm(form({ model: "preset:pre-fast" }), picker), {
    models: { maker: { model: "gpt-5-mini", provider: "openai", credentialId: null }, checker: [{ model: "anthropic/claude-sonnet-4.5", credentialId: ROUTER }] },
  });
  assert.deepEqual(modelsFromForm(form({ model: "more", maker: `${OPENAI}|openai|gpt-5`, checker: "" }), picker), {
    models: { maker: { model: "gpt-5", credentialId: OPENAI } },
  });
  assert.deepEqual(modelsFromForm(form({ model: "more", maker: "", checker: "orqon|anthropic|claude-opus-4-1" }), picker), {
    models: { checker: [{ model: "claude-opus-4-1", provider: "anthropic", credentialId: null }] },
  });
  const dependent = modelsFromForm(form({ model: "more", maker: `${ROUTER}|openrouter|anthropic/claude-sonnet-4.5`, checker: "" }), picker);
  assert.ok("problem" in dependent && /no checker model is independent/.test(dependent.problem));
  assert.ok("problem" in modelsFromForm(form({ model: "preset:gone" }), picker));
  assert.ok("problem" in modelsFromForm(form({ model: "", mode: "pair" }), picker));

  const two = buildPicker(policy({ harnesses: [{ id: "codex", label: "OpenAI's Codex CLI", default: true }, { id: "claude-code", label: "Claude Code", default: false }] }), creds);
  assert.deepEqual(modelsFromForm(form({ model: "", harness: "codex" }), two), { models: null }, "the default agent is not sent");
  assert.deepEqual(modelsFromForm(form({ model: "", harness: "claude-code" }), two), {
    models: { maker: { model: "gpt-5-codex", provider: "openai", credentialId: null, harness: "claude-code" } },
  });
  assert.ok("problem" in modelsFromForm(form({ model: "", harness: "opencode" }), two));
});

test("Run again with… sends exactly what the dialog shows: the defaults materialized, the agent named", () => {
  const rerun = { rerun: true };
  const picker = buildPicker(policy(), creds);
  const DEFAULT_MAKER = { model: "gpt-5-codex", provider: "openai", credentialId: null };
  const DEFAULT_CHECKER = { model: "claude-sonnet-4-5", provider: "anthropic", credentialId: null };
  assert.deepEqual(modelsFromForm(form({ model: "" }), picker, rerun), {
    models: { maker: { ...DEFAULT_MAKER, harness: "codex" }, checker: [DEFAULT_CHECKER] },
  });
  assert.deepEqual(modelsFromForm(form({ model: TASK_MODELS }), picker, rerun), { models: null });
  assert.ok("problem" in modelsFromForm(form({ model: TASK_MODELS }), picker), "not offered outside a re-run");
  assert.deepEqual(modelsFromForm(form({ model: "more", maker: `${OPENAI}|openai|gpt-5`, checker: "" }), picker, rerun), {
    models: { maker: { model: "gpt-5", credentialId: OPENAI, harness: "codex" }, checker: [DEFAULT_CHECKER] },
  });
  assert.deepEqual(modelsFromForm(form({ model: "more", maker: "", checker: "orqon|anthropic|claude-opus-4-1" }), picker, rerun), {
    models: { maker: { ...DEFAULT_MAKER, harness: "codex" }, checker: [{ model: "claude-opus-4-1", provider: "anthropic", credentialId: null }] },
  });
  assert.deepEqual(modelsFromForm(form({ model: "preset:pre-fast" }), picker, rerun), {
    models: { maker: { model: "gpt-5-mini", provider: "openai", credentialId: null, harness: "codex" }, checker: [{ model: "anthropic/claude-sonnet-4.5", credentialId: ROUTER }] },
  });
  const two = buildPicker(policy({ harnesses: [{ id: "codex", label: "OpenAI's Codex CLI", default: true }, { id: "claude-code", label: "Claude Code", default: false }] }), creds);
  assert.ok("problem" in modelsFromForm(form({ model: TASK_MODELS, harness: "claude-code" }), two, rerun));
  assert.deepEqual(modelsFromForm(form({ model: "", harness: "claude-code" }), two, rerun), {
    models: { maker: { ...DEFAULT_MAKER, harness: "claude-code" }, checker: [DEFAULT_CHECKER] },
  });
  const bare = buildPicker(policy({ items: [row("maker", "openai", "gpt-5-codex")] }), creds);
  assert.match(rerunDefaultProblem(bare)!, /no default checker model set/);
  const refused = modelsFromForm(form({ model: "" }), bare, rerun);
  assert.ok("problem" in refused && /Same models as this task/.test(refused.problem));
  assert.ok("models" in modelsFromForm(form({ model: "more", maker: "", checker: "orqon|anthropic|claude-opus-4-1" }), bare, rerun));
  assert.equal(rerunDefaultProblem(picker), null);
});

test("noIndependentReason mirrors intake: the first independent checker clears the pair", () => {
  assert.equal(noIndependentReason({ provider: "openai", model: "gpt-5" }, [{ provider: "openrouter", model: "openai/gpt-5-mini" }, { provider: "anthropic", model: "claude-opus-4-1" }]), null);
  assert.equal(
    noIndependentReason({ provider: "openai", model: "gpt-5" }, [{ provider: "openrouter", model: "openai/gpt-5-mini" }]),
    "no checker model is independent of the maker (openai/gpt-5): openrouter/openai/gpt-5-mini serves openai's model, and openai is the maker's vendor (ADR-0010, ADR-0026 §5)",
  );
});

test("the session header's snapshot line: harness, maker, checker, key source", () => {
  const config: RunModelConfig = {
    version: 1,
    maker: { provider: "openai", vendor: "openai", model: "gpt-5-codex", keySource: "customer", credentialLabel: "prod", source: "run", worker: "codex" },
    checker: [{ provider: "anthropic", vendor: "anthropic", model: "claude-opus-4-1", keySource: "orqon", source: "operator" }],
    resolvedAt: "",
    policyIds: [],
  };
  const line = snapshotLine(config)!;
  assert.equal(line.text, "OpenAI's Codex CLI · gpt-5-codex · checked by claude-opus-4-1 · mixed keys");
  assert.match(line.title, /key “prod”/);
  assert.match(line.title, /Changing models is a new run/);
  assert.equal(snapshotLine(null), null);
  assert.equal(snapshotLine({ ...config, checker: [], maker: { ...config.maker, keySource: "orqon", worker: undefined } })!.text, "the default agent · gpt-5-codex · no checker · Windkeel-managed keys");
});

test("the header names the checker verification will use, not checker[0] when that's the maker's vendor", () => {
  const config: RunModelConfig = {
    version: 1,
    maker: { provider: "openai", vendor: "openai", model: "gpt-5-codex", keySource: "orqon", source: "task", worker: "codex" },
    checker: [
      { provider: "openrouter", vendor: "openai", model: "openai/gpt-5-mini", keySource: "orqon", source: "task" },
      { provider: "anthropic", vendor: "anthropic", model: "claude-opus-4-1", keySource: "customer", credentialLabel: "anthropic-prod", source: "task" },
    ],
    resolvedAt: "",
    policyIds: [],
  };
  assert.equal(selectedCheckerIndex(config), 1);
  const line = snapshotLine(config)!;
  assert.equal(line.text, "OpenAI's Codex CLI · gpt-5-codex · checked by claude-opus-4-1 · mixed keys");
  assert.match(line.title, /checker anthropic's claude-opus-4-1/);
  assert.doesNotMatch(line.title, /gpt-5-mini/);
  const none = { ...config, checker: [config.checker[0]!] };
  assert.equal(selectedCheckerIndex(none), -1);
  assert.equal(snapshotLine(none)!.text, "OpenAI's Codex CLI · gpt-5-codex · no independent checker · Windkeel-managed keys");
});
