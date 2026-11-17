import {
  MODEL_SUGGESTIONS,
  harnessName,
  noIndependentReason,
  type HarnessView,
  type ModelCredential,
  type ModelPolicyLayer,
  type ModelPreset,
  type ModelProvider,
  type TaskModelChoice,
  type TaskModels,
} from "./models.ts";

interface Judged {
  provider: string;
  model: string;
  declaredVendor?: string | null;
}

export interface PickerOption {
  key: string;
  label: string;
  choice: TaskModelChoice;
  judged: Judged;
}

export interface PickerPreset {
  id: string;
  name: string;
  harness: string | null;
  label: string;
  maker: TaskModelChoice;
  checker: TaskModelChoice[];
  disabledReason: string | null;
}

export interface ModelPicker {
  defaultMaker: { label: string; judged: Judged | null; choice: TaskModelChoice | null };
  defaultChecker: { label: string; judged: Judged | null; choice: TaskModelChoice | null };
  presets: PickerPreset[];
  makers: PickerOption[];
  checkers: PickerOption[];
  harnesses: HarnessView[];
}

export const MODE_OPTIONS = [
  { value: "autonomous", label: "Autonomous", detail: "Windkeel works, verifies and brings you the result.", available: true },
  { value: "pair", label: "Pair", detail: "Stops after the first turn so you can look. Arrives with take-over.", available: false },
] as const;

export const ORG_DEFAULT = "(organization default)";

export const TASK_MODELS = "task";
export const TASK_MODELS_LABEL = "Same models as this task (its own choice, else the defaults beneath it)";
const WINDKEEL = "orqon";

const keyOf = (credentialId: string | null, provider: string, model: string) => `${credentialId ?? WINDKEEL}|${provider}|${model}`;

const MAKER_PROVIDERS: readonly ModelProvider[] = ["openai", "openrouter"];

function judgedOf(choice: TaskModelChoice, credentials: readonly ModelCredential[]): Judged | null {
  if (choice.credentialId) {
    const credential = credentials.find((c) => c.id === choice.credentialId);
    if (!credential) return null;
    return { provider: credential.provider, model: choice.model, declaredVendor: choice.declaredVendor ?? credential.declaredVendor };
  }
  if (!choice.provider) return null;
  return { provider: choice.provider, model: choice.model, declaredVendor: choice.declaredVendor ?? null };
}

function presetLabel(p: ModelPreset, harnesses: readonly HarnessView[]): string {
  const agent = p.harness && harnesses.length > 1 ? ` on ${harnessName(p.harness, harnesses)}` : "";
  return `${p.name} — ${p.maker.model}${agent} · checked by ${p.checker[0]?.model ?? "?"}`;
}

export function buildPicker(policy: ModelPolicyLayer, credentials: readonly ModelCredential[]): ModelPicker {
  const live = credentials.filter((c) => c.status !== "revoked" && c.status !== "invalid");
  const harnesses = policy.harnesses?.length ? policy.harnesses : [{ id: "codex", label: "OpenAI's Codex CLI", default: true }];
  const row = (role: "maker" | "checker") => policy.items.find((p) => p.role === role && p.repositoryId === null) ?? null;
  const makerRow = row("maker");
  const checkerRow = row("checker");
  const rowChoice = (r: NonNullable<ReturnType<typeof row>>): TaskModelChoice =>
    r.credentialId
      ? { model: r.model, credentialId: r.credentialId, ...(r.declaredVendor ? { declaredVendor: r.declaredVendor } : {}) }
      : { model: r.model, provider: r.provider, credentialId: null, ...(r.declaredVendor ? { declaredVendor: r.declaredVendor } : {}) };
  const rowJudged = (r: NonNullable<ReturnType<typeof row>>): Judged => {
    const credential = r.credentialId ? credentials.find((c) => c.id === r.credentialId) : null;
    return { provider: r.provider, model: r.model, declaredVendor: r.declaredVendor ?? credential?.declaredVendor ?? null };
  };

  const option = (credential: ModelCredential | null, provider: string, model: string): PickerOption => ({
    key: keyOf(credential?.id ?? null, provider, model),
    label: credential ? `${model} · key “${credential.label}”` : `${model} · Windkeel-managed`,
    choice: credential ? { model, credentialId: credential.id } : { model, provider, credentialId: null },
    judged: { provider, model, declaredVendor: credential?.declaredVendor ?? null },
  });
  const raw = (providers: readonly ModelProvider[], managed: readonly ModelProvider[]): PickerOption[] => {
    const out: PickerOption[] = [];
    for (const provider of managed) for (const model of MODEL_SUGGESTIONS[provider]) out.push(option(null, provider, model));
    for (const credential of live) {
      if (!(providers as readonly string[]).includes(credential.provider)) continue;
      for (const model of MODEL_SUGGESTIONS[credential.provider as ModelProvider] ?? []) out.push(option(credential, credential.provider, model));
    }
    return out;
  };
  const enabled = new Set(harnesses.map((h) => h.id));

  const presets: PickerPreset[] = (policy.presets ?? []).map((p) => {
    let disabledReason: string | null = null;
    if (p.harness && !enabled.has(p.harness)) disabledReason = `Its agent, ${harnessName(p.harness, harnesses)}, isn't enabled on this deployment.`;
    else {
      const maker = judgedOf(p.maker, credentials);
      const checkers = p.checker.map((c) => judgedOf(c, credentials));
      if (!maker || checkers.some((c) => c === null)) disabledReason = "It names a key that's since been revoked. An admin can fix it in Settings → Models.";
      else disabledReason = noIndependentReason(maker, checkers as Judged[]);
    }
    return { id: p.id, name: p.name, harness: p.harness, label: presetLabel(p, harnesses), maker: p.maker, checker: p.checker, disabledReason };
  });

  return {
    defaultMaker: makerRow
      ? { label: `${makerRow.model} ${ORG_DEFAULT}`, judged: rowJudged(makerRow), choice: rowChoice(makerRow) }
      : { label: `Windkeel's default model ${ORG_DEFAULT}`, judged: null, choice: null },
    defaultChecker: checkerRow
      ? { label: `${checkerRow.model} ${ORG_DEFAULT}`, judged: rowJudged(checkerRow), choice: rowChoice(checkerRow) }
      : { label: `Windkeel's default checker ${ORG_DEFAULT}`, judged: null, choice: null },
    presets,
    makers: raw(MAKER_PROVIDERS, ["openai"]),
    checkers: raw(["openai", "anthropic", "openrouter"], ["anthropic"]),
    harnesses,
  };
}

export function defaultLabel(picker: ModelPicker): string {
  const maker = picker.defaultMaker.judged?.model ?? "Windkeel's default model";
  const checker = picker.defaultChecker.judged?.model;
  return `${maker}${checker ? ` · checked by ${checker}` : ""} ${ORG_DEFAULT}`;
}

export const showsAgentPicker = (picker: ModelPicker | null | undefined): boolean => (picker?.harnesses.length ?? 0) > 1;

const findMaker = (picker: ModelPicker, key: string) => (key ? picker.makers.find((o) => o.key === key) ?? null : null);
const findChecker = (picker: ModelPicker, key: string) => (key ? picker.checkers.find((o) => o.key === key) ?? null : null);

export function pairReason(picker: ModelPicker, makerKey: string, checkerKey: string): string | null {
  const maker = findMaker(picker, makerKey)?.judged ?? (makerKey ? null : picker.defaultMaker.judged);
  const checker = findChecker(picker, checkerKey)?.judged ?? (checkerKey ? null : picker.defaultChecker.judged);
  if (!maker || !checker) return null;
  return noIndependentReason(maker, [checker]);
}

export function makerOptions(picker: ModelPicker, checkerKey: string): Array<PickerOption & { disabledReason: string | null }> {
  return picker.makers.map((o) => ({ ...o, disabledReason: pairReason(picker, o.key, checkerKey) }));
}

export function checkerOptions(picker: ModelPicker, makerKey: string): Array<PickerOption & { disabledReason: string | null }> {
  return picker.checkers.map((o) => ({ ...o, disabledReason: pairReason(picker, makerKey, o.key) }));
}

export function rerunDefaultProblem(picker: ModelPicker, roles: ReadonlyArray<"maker" | "checker"> = ["maker", "checker"]): string | null {
  const missing = roles.filter((role) => !(role === "maker" ? picker.defaultMaker.choice : picker.defaultChecker.choice));
  if (!missing.length) return null;
  return (
    `This organization has no default ${missing.join(" or ")} model set, so the console can't name it for a new run — ` +
    `the task's own choice would apply instead. Choose “Same models as this task”, a preset, or the ${missing.join(" and ")} under More.`
  );
}

export function modelsFromForm(
  form: FormData,
  picker: ModelPicker | null,
  options: { rerun?: boolean } = {},
): { models: TaskModels | null } | { problem: string } {
  if (!picker) return { models: null };
  const rerun = options.rerun === true;
  const text = (name: string) => String(form.get(name) ?? "").trim();
  const mode = text("mode") || "autonomous";
  if (mode !== "autonomous") return { problem: "Only Autonomous is available for now. Pair arrives with take-over." };
  const selected = text("model");
  const harnessKey = text("harness");
  const defaultHarness = picker.harnesses.find((h) => h.default)?.id ?? picker.harnesses[0]?.id;
  const harness = harnessKey && harnessKey !== defaultHarness ? harnessKey : "";
  if (harness && !picker.harnesses.some((h) => h.id === harness)) return { problem: "That agent isn't enabled on this deployment." };

  if (rerun && selected === TASK_MODELS) {
    if (harness) return { problem: `To run on ${harnessName(harness, picker.harnesses)}, choose the models too — a preset, the default, or under More.` };
    return { models: null };
  }

  let models: TaskModels | null = null;
  if (selected.startsWith("preset:")) {
    const preset = picker.presets.find((p) => p.id === selected.slice("preset:".length));
    if (!preset) return { problem: "That preset is gone. Choose another." };
    if (preset.disabledReason) return { problem: `“${preset.name}” can't be used: ${preset.disabledReason}` };
    const { harness: _ignored, ...maker } = preset.maker;
    const presetHarness = preset.harness ?? (rerun ? defaultHarness : undefined);
    return { models: { maker: { ...maker, ...(presetHarness ? { harness: presetHarness } : {}) }, checker: preset.checker } };
  }
  if (selected === "more") {
    const makerKey = text("maker");
    const checkerKey = text("checker");
    const maker = findMaker(picker, makerKey);
    const checker = findChecker(picker, checkerKey);
    if (makerKey && !maker) return { problem: "That maker model isn't offered any more. Choose another." };
    if (checkerKey && !checker) return { problem: "That checker model isn't offered any more. Choose another." };
    const reason = pairReason(picker, makerKey, checkerKey);
    if (reason) return { problem: reason };
    if (maker || checker) models = { ...(maker ? { maker: maker.choice } : {}), ...(checker ? { checker: [checker.choice] } : {}) };
  } else if (selected !== "") {
    return { problem: "Choose a model from the list." };
  }
  if (rerun) {
    const blank = (["maker", "checker"] as const).filter((role) => !models?.[role]);
    const problem = rerunDefaultProblem(picker, blank);
    if (problem) return { problem };
    const maker = models?.maker ?? picker.defaultMaker.choice!;
    const checker = models?.checker ?? [picker.defaultChecker.choice!];
    const runHarness = harness || defaultHarness;
    return { models: { maker: { ...maker, ...(runHarness ? { harness: runHarness } : {}) }, checker } };
  }
  if (harness) {
    const maker = models?.maker ?? picker.defaultMaker.choice;
    if (!maker) return { problem: `Choose a maker model for ${harnessName(harness, picker.harnesses)} under More.` };
    models = { ...(models ?? {}), maker: { ...maker, harness } };
  }
  return { models };
}
