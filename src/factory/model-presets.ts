

import type { Pool, PoolClient } from "pg";
import { isModelProvider, type ModelProvider } from "@windkeel/verification/providers/catalog.js";
import type { ModelEndpoint } from "@windkeel/verification/providers/types.js";
import {
  deleteModelPresetRow,
  insertModelPresetRow,
  selectModelPresetRow,
  selectModelPresetRows,
  updateModelPresetRow,
} from "./stores/model-policy-store.js";
import {
  deriveVendor,
  independenceReason,
  ModelPolicyError,
  parseTaskModelOverride,
  usableCredential,
  UUID_SHAPE,
  type TaskModelChoice,
} from "./model-policy.js";

type Db = Pool | PoolClient;

export interface ModelPreset {
  id: string;
  organizationId: string;
  name: string;

  harness: string | null;
  maker: TaskModelChoice;

  checker: TaskModelChoice[];
  createdByPrincipalId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ModelPresetInput {
  name?: unknown;
  harness?: unknown;
  maker?: unknown;
  checker?: unknown;
}

const invalid = (message: string) => new ModelPolicyError(400, "invalid_model_preset", message);
const NAME_MAX = 40;

function mapRow(row: Record<string, unknown>): ModelPreset {
  return {
    id: row["id"] as string,
    organizationId: row["organization_id"] as string,
    name: row["name"] as string,
    harness: (row["harness"] as string | null) ?? null,
    maker: row["maker"] as TaskModelChoice,
    checker: row["checker"] as TaskModelChoice[],
    createdByPrincipalId: (row["created_by_principal_id"] as string | null) ?? null,
    createdAt: row["created_at"] as Date,
    updatedAt: row["updated_at"] as Date,
  };
}

function checkedName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (name.length === 0 || name.length > NAME_MAX) throw invalid(`name must be 1-${NAME_MAX} characters`);
  return name;
}

async function concrete(
  db: Db,
  organizationId: string,
  choice: TaskModelChoice,
  role: "maker" | "checker",
): Promise<ModelEndpoint> {
  let provider: ModelProvider;
  let baseUrl: string | undefined;
  let declaredVendor = choice.declaredVendor;
  if (choice.credentialId) {
    const credential = await usableCredential(db, organizationId, choice.credentialId);
    if (choice.provider !== undefined && choice.provider !== credential.provider) {
      throw invalid(`the ${role} names provider ${choice.provider}, but model credential "${credential.label}" is for ${credential.provider}`);
    }
    if (!isModelProvider(credential.provider)) throw invalid(`model credential "${credential.label}" has an unknown provider`);
    provider = credential.provider;
    baseUrl = credential.baseUrl ?? undefined;
    declaredVendor = declaredVendor ?? credential.declaredVendor ?? undefined;
  } else {

    if (choice.provider === undefined || !isModelProvider(choice.provider)) {
      throw invalid(`the ${role} needs a provider or a model credential`);
    }
    provider = choice.provider;
  }
  const vendor = deriveVendor(provider, choice.model, declaredVendor);
  return { vendor, provider, model: choice.model, apiKey: "", ...(baseUrl ? { baseUrl } : {}) };
}

async function checkedPreset(
  db: Db,
  organizationId: string,
  input: ModelPresetInput,
  enabledHarnesses: readonly string[],
): Promise<{ name: string; harness: string | null; maker: TaskModelChoice; checker: TaskModelChoice[] }> {
  const name = checkedName(input.name);
  let harness: string | null = null;
  if (input.harness !== undefined && input.harness !== null && input.harness !== "") {
    if (typeof input.harness !== "string") throw invalid("harness must be a harness id, like codex");
    if (!enabledHarnesses.includes(input.harness)) {
      throw new ModelPolicyError(
        422,
        "harness_unavailable",
        `${input.harness} is not a maker harness this deployment enables (it enables ${enabledHarnesses.join(", ")})`,
      );
    }
    harness = input.harness;
  }
  if (input.maker === undefined || input.checker === undefined) {
    throw invalid("a preset names both a maker and a checker: { name, harness?, maker, checker }");
  }
  let parsed;
  try {
    parsed = parseTaskModelOverride({ maker: input.maker, checker: input.checker });
  } catch (error) {
    if (error instanceof ModelPolicyError) throw invalid(error.message);
    throw error;
  }
  const maker = parsed?.maker;
  const checker = parsed?.checker;
  if (!maker || !checker) throw invalid("a preset names both a maker and a checker");

  const { harness: _inner, ...makerChoice } = maker;

  const makerEndpoint = await concrete(db, organizationId, makerChoice, "maker");
  const checkerEndpoints: ModelEndpoint[] = [];
  for (const choice of checker) checkerEndpoints.push(await concrete(db, organizationId, choice, "checker"));
  const dependent = independenceReason({ vendor: makerEndpoint.vendor, model: makerEndpoint.model }, checkerEndpoints);
  if (dependent) throw new ModelPolicyError(409, "no_independent_checker", dependent);
  return { name, harness, maker: makerChoice, checker };
}

export async function listModelPresets(db: Db, organizationId: string): Promise<ModelPreset[]> {
  return (await selectModelPresetRows(db, organizationId)).map(mapRow);
}

export async function getModelPreset(db: Db, organizationId: string, presetId: string): Promise<ModelPreset | null> {
  if (!UUID_SHAPE.test(presetId)) return null;
  const row = await selectModelPresetRow(db, organizationId, presetId);
  return row ? mapRow(row) : null;
}

function nameTaken(error: unknown, name: string): never {
  if ((error as { code?: string }).code === "23505") {
    throw new ModelPolicyError(409, "preset_name_taken", `a preset named "${name}" already exists`);
  }
  throw error;
}

export async function createModelPreset(
  db: Db,
  organizationId: string,
  input: ModelPresetInput,
  options: { enabledHarnesses: readonly string[]; createdByPrincipalId?: string | null },
): Promise<ModelPreset> {
  const preset = await checkedPreset(db, organizationId, input, options.enabledHarnesses);
  try {
    const row = await insertModelPresetRow(
      db,
      organizationId,
      { name: preset.name, harness: preset.harness, maker: JSON.stringify(preset.maker), checker: JSON.stringify(preset.checker) },
      options.createdByPrincipalId ?? null,
    );
    return mapRow(row);
  } catch (error) {
    return nameTaken(error, preset.name);
  }
}

export async function updateModelPreset(
  db: Db,
  organizationId: string,
  presetId: string,
  input: ModelPresetInput,
  options: { enabledHarnesses: readonly string[] },
): Promise<ModelPreset | null> {
  if (!(await getModelPreset(db, organizationId, presetId))) return null;
  const preset = await checkedPreset(db, organizationId, input, options.enabledHarnesses);
  try {
    const row = await updateModelPresetRow(db, organizationId, presetId, {
      name: preset.name,
      harness: preset.harness,
      maker: JSON.stringify(preset.maker),
      checker: JSON.stringify(preset.checker),
    });
    return row ? mapRow(row) : null;
  } catch (error) {
    return nameTaken(error, preset.name);
  }
}

export async function deleteModelPreset(db: Db, organizationId: string, presetId: string): Promise<boolean> {
  if (!UUID_SHAPE.test(presetId)) return false;
  return (await deleteModelPresetRow(db, organizationId, presetId)) > 0;
}
