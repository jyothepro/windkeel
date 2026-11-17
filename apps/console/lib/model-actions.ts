import type { ActionResult } from "./action-result.ts";
import { ApiError } from "./http.ts";
import {
  MODEL_PROVIDERS,
  MODEL_ROLES,
  independenceProblem,
  type ModelCredential,
  type ModelPreset,
  type ModelRole,
  type HarnessView,
  type ModelsApi,
  type PolicyChoice,
  type PresetInput,
  type ValidationStart,
} from "./models.ts";
import { refusalText } from "./refusals.ts";

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const fail = (message: string): ActionResult => ({ ok: false, message });

async function guard(fn: () => Promise<ActionResult>): Promise<ActionResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) return fail(refusalText(err.code, err.message));
    throw err;
  }
}

export function validationWords(validation: ValidationStart): string {
  if (validation === "started") return "Windkeel is checking it with the provider now; its status changes from unverified within a minute.";
  if (validation === "unavailable") return "This deployment can't check keys, so it stays unverified until one can.";
  return "The check couldn't be started. It's stored; press Check again in a moment.";
}

function keyValue(form: FormData): string | { problem: string } {
  const value = String(form.get("value") ?? "").trim();
  if (!value) return { problem: "Paste the key." };
  if (/\s/.test(value)) return { problem: "That key has a space or a line break in it. Paste just the key." };
  return value;
}

export function addCredential(api: ModelsApi, orgId: string, form: FormData): Promise<ActionResult> {
  const provider = text(form, "provider");
  const label = text(form, "label");
  const baseUrl = text(form, "baseUrl");
  const declaredVendor = text(form, "declaredVendor").toLowerCase();
  if (!(MODEL_PROVIDERS as readonly string[]).includes(provider)) return Promise.resolve(fail("Choose the provider this key is for."));
  if (!label) return Promise.resolve(fail("Name it so people can tell keys apart — prod, team-budget, vllm."));
  if (provider === "openai-compatible" && !baseUrl) return Promise.resolve(fail("An OpenAI-compatible endpoint needs its base URL, like https://llm.example.com/v1."));
  if (baseUrl && !/^https:\/\//i.test(baseUrl) && !/^http:\/\/localhost[:/]/i.test(baseUrl)) {
    return Promise.resolve(fail("The base URL must be https://. Windkeel never sends a key in the clear."));
  }
  const value = keyValue(form);
  if (typeof value !== "string") return Promise.resolve(fail(value.problem));
  return guard(async () => {
    const { credential, validation } = await api.createCredential(orgId, {
      provider,
      label,
      value,
      ...(baseUrl ? { baseUrl } : {}),
      ...(declaredVendor ? { declaredVendor } : {}),
    });
    return { ok: true, message: `Stored “${credential.label}” (…${credential.last4}). ${validationWords(validation)}` };
  });
}

export function rotateCredential(api: ModelsApi, orgId: string, credentialId: string, form: FormData): Promise<ActionResult> {
  const value = keyValue(form);
  if (typeof value !== "string") return Promise.resolve(fail(value.problem));
  return guard(async () => {
    const { credential, validation } = await api.rotateCredential(orgId, credentialId, value);
    return { ok: true, message: `Rotated “${credential.label}” — now …${credential.last4}. ${validationWords(validation)}` };
  });
}

export function revokeCredential(api: ModelsApi, orgId: string, credentialId: string): Promise<ActionResult> {
  return guard(async () => {
    await api.revokeCredential(orgId, credentialId);
    return { ok: true };
  });
}

export function checkCredential(api: ModelsApi, orgId: string, credentialId: string): Promise<ActionResult> {
  return guard(async () => {
    await api.validateCredential(orgId, credentialId);
    return { ok: true, message: validationWords("started") };
  });
}

export const WINDKEEL_MANAGED = "orqon";

export function readPolicyForm(
  form: FormData,
  credentials: readonly Pick<ModelCredential, "id" | "label" | "provider" | "declaredVendor" | "status">[],
): { body: Partial<Record<ModelRole, PolicyChoice>>; resolved: Partial<Record<ModelRole, { provider: string; model: string; declaredVendor?: string | null }>> } | { problem: string } {
  const body: Partial<Record<ModelRole, PolicyChoice>> = {};
  const resolved: Partial<Record<ModelRole, { provider: string; model: string; declaredVendor?: string | null }>> = {};
  for (const role of MODEL_ROLES) {
    const model = text(form, `${role}.model`);
    if (!model) continue;
    const key = text(form, `${role}.key`) || WINDKEEL_MANAGED;
    const declaredVendor = text(form, `${role}.declaredVendor`).toLowerCase();
    if (key === WINDKEEL_MANAGED) {
      const provider = text(form, `${role}.provider`);
      if (!(MODEL_PROVIDERS as readonly string[]).includes(provider)) return { problem: `Choose the ${role}'s provider.` };
      if (provider === "openai-compatible") return { problem: `An OpenAI-compatible endpoint needs your own key: Windkeel has none for it. Add one above and choose it for the ${role}.` };
      body[role] = { model, provider, credentialId: null, ...(declaredVendor ? { declaredVendor } : {}) };
      resolved[role] = { provider, model, declaredVendor: declaredVendor || null };
    } else {
      const credential = credentials.find((c) => c.id === key);
      if (!credential || credential.status === "revoked") return { problem: `That key for the ${role} is gone. Choose another.` };
      body[role] = { model, credentialId: credential.id, ...(declaredVendor ? { declaredVendor } : {}) };
      resolved[role] = { provider: credential.provider, model, declaredVendor: declaredVendor || credential.declaredVendor };
    }
  }
  if (!body.maker && !body.checker) return { problem: "Give the maker, the checker, or both a model." };
  return { body, resolved };
}

export function savePolicy(
  api: ModelsApi,
  orgId: string,
  repositoryId: string | null,
  form: FormData,
  credentials: readonly ModelCredential[],
  below: Partial<Record<ModelRole, { provider: string; model: string; declaredVendor?: string | null }>> = {},
): Promise<ActionResult> {
  const read = readPolicyForm(form, credentials);
  if ("problem" in read) return Promise.resolve(fail(read.problem));
  return guard(async () => {
    await api.setPolicy(orgId, repositoryId, read.body);
    const problem = independenceProblem(read.resolved.maker ?? below.maker ?? null, read.resolved.checker ?? below.checker ?? null);
    return { ok: true, message: problem ? `Saved — but ${problem.charAt(0).toLowerCase()}${problem.slice(1)}` : "Saved. Runs that start from now on use it." };
  });
}

export function clearPolicy(api: ModelsApi, orgId: string, repositoryId: string | null, role: string): Promise<ActionResult> {
  if (!(MODEL_ROLES as readonly string[]).includes(role)) return Promise.resolve(fail(`Unknown role: ${role}.`));
  return guard(async () => {
    await api.clearPolicy(orgId, repositoryId, role as ModelRole);
    return { ok: true };
  });
}

export function readPresetForm(
  form: FormData,
  credentials: readonly Pick<ModelCredential, "id" | "label" | "provider" | "declaredVendor" | "status">[],
  harnesses: readonly HarnessView[],
): { input: PresetInput; resolved: Partial<Record<ModelRole, { provider: string; model: string; declaredVendor?: string | null }>> } | { problem: string } {
  const name = text(form, "name").replace(/\s+/g, " ");
  if (!name) return { problem: "Name it — Fast, Thorough, whatever your team will recognise." };
  if (name.length > 40) return { problem: "Keep the name to 40 characters." };
  const harness = text(form, "harness");
  if (harness && !harnesses.some((h) => h.id === harness)) return { problem: "That agent isn't enabled on this deployment." };
  const read = readPolicyForm(form, credentials);
  if ("problem" in read) return read;
  if (!read.body.maker || !read.body.checker) return { problem: "A preset names both a maker and a checker model." };
  const isDefault = harnesses.find((h) => h.default)?.id === harness;
  return {
    input: { name, harness: harness && !isDefault ? harness : null, maker: read.body.maker, checker: [read.body.checker] },
    resolved: read.resolved,
  };
}

export function savePreset(
  api: ModelsApi,
  orgId: string,
  presetId: string | null,
  form: FormData,
  credentials: readonly ModelCredential[],
  harnesses: readonly HarnessView[],
  existing: Pick<ModelPreset, "checker"> | null = null,
): Promise<ActionResult> {
  const read = readPresetForm(form, credentials, harnesses);
  if ("problem" in read) return Promise.resolve(fail(read.problem));
  const problem = independenceProblem(read.resolved.maker ?? null, read.resolved.checker ?? null);
  if (problem) return Promise.resolve(fail(problem));
  const input: PresetInput = presetId && existing ? { ...read.input, checker: [...read.input.checker.slice(0, 1), ...existing.checker.slice(1)] } : read.input;
  return guard(async () => {
    const preset = presetId ? await api.updatePreset(orgId, presetId, input) : await api.createPreset(orgId, input);
    return { ok: true, message: `Saved “${preset.name}”. It's offered first in the composer's model picker.` };
  });
}

export function fallbackNote(p: Pick<ModelPreset, "checker">): string {
  const rest = p.checker.slice(1);
  return `The checker below is the first choice. This preset also has ${rest.length} fallback checker${rest.length === 1 ? "" : "s"} (${rest
    .map((c) => c.model)
    .join(", then ")}), tried in order when an earlier one isn't independent of the maker; saving keeps ${rest.length === 1 ? "it" : "them"} unchanged.`;
}

export function deletePreset(api: ModelsApi, orgId: string, presetId: string): Promise<ActionResult> {
  return guard(async () => {
    await api.deletePreset(orgId, presetId);
    return { ok: true };
  });
}
