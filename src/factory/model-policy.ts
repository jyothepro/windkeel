

import type { Pool, PoolClient } from "pg";
import {
  isModelProvider,
  PROVIDERS,
  vendorOf,
  type ModelProvider,
} from "@windkeel/verification/providers/catalog.js";
import { checkIndependence, derivedVendor } from "@windkeel/verification/providers/index.js";
import type { ModelEndpoint, ModelPolicy } from "@windkeel/verification/providers/types.js";
import { HARNESS_SHAPE } from "./harnesses.js";
import { harnessProviderRefusal } from "../worker/descriptor.js";
import { getModelCredential, type ModelCredential } from "./model-credentials.js";
import { deleteModelPolicyRows, selectModelPolicyRows, upsertModelPolicyRow } from "./stores/model-policy-store.js";

type Db = Pool | PoolClient;

export type ModelRole = "maker" | "checker";
export const MODEL_ROLES: readonly ModelRole[] = ["maker", "checker"];

export type KeySource = "orqon" | "customer";

export type ChoiceSource = "run" | "task" | "repository" | "organization" | "operator";

export interface RunModelChoice {

  provider: ModelProvider;

  vendor: string;
  model: string;

  baseUrl?: string;

  credentialId?: string;

  credentialLabel?: string;

  declaredVendor?: string;
  keySource: KeySource;
  source: ChoiceSource;
}

export interface RunModelConfig {
  version: 1;

  maker: RunModelChoice & { worker?: string; harness?: RunHarnessChoice };

  checker: RunModelChoice[];
  resolvedAt: string;

  policyIds: string[];
}

export interface RunHarnessChoice {
  id: string;
  version: string;
}

export interface TaskModelChoice {
  model: string;

  provider?: string;

  credentialId?: string | null;
  declaredVendor?: string;

  harness?: string;
}

export interface TaskModelOverride {
  maker?: TaskModelChoice;
  checker?: TaskModelChoice[];
}

export interface ModelPolicyEntry {
  id: string;
  organizationId: string;
  repositoryId: string | null;
  role: ModelRole;
  provider: string;
  model: string;
  credentialId: string | null;
  declaredVendor: string | null;

  harness: string | null;
  createdAt: Date;
  updatedAt: Date;
  updatedByPrincipalId: string | null;
}

export class ModelPolicyError extends Error {
  override readonly name = "ModelPolicyError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const invalid = (message: string) => new ModelPolicyError(400, "invalid_model_policy", message);

const MODEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const VENDOR_SHAPE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkedProvider(value: unknown): ModelProvider {
  if (!isModelProvider(value)) {
    throw invalid(`provider must be one of ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return value;
}

function checkedModel(value: unknown): string {
  if (typeof value !== "string" || !MODEL_SHAPE.test(value.trim())) {
    throw invalid("model must be 1-200 characters of letters, digits and . _ : / @ + -");
  }
  return value.trim();
}

function checkedVendor(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !VENDOR_SHAPE.test(value)) {
    throw invalid("declared vendor must be lower-case letters, digits and '-', at most 32 characters");
  }
  return value;
}

function checkedCredentialId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || !UUID_SHAPE.test(value)) {
    throw invalid("credentialId must be a model credential id, or null for Windkeel-managed");
  }
  return value;
}

function parseTaskChoice(value: unknown, role: ModelRole): TaskModelChoice {
  if (typeof value === "string") return { model: checkedModel(value) };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`models.${role} must be a model name or { model, provider?, credentialId?, declaredVendor? }`);
  }
  const fields = value as Record<string, unknown>;
  const credentialId = checkedCredentialId(fields["credentialId"]);
  const declaredVendor = checkedVendor(fields["declaredVendor"]);
  const harness = fields["harness"];
  if (harness !== undefined && harness !== null) {
    if (role !== "maker") throw invalid("only the maker has a harness");
    if (typeof harness !== "string" || !HARNESS_SHAPE.test(harness)) {
      throw invalid("models.maker.harness must be a harness id, like codex");
    }
  }
  return {
    model: checkedModel(fields["model"]),
    ...(fields["provider"] !== undefined ? { provider: checkedProvider(fields["provider"]) } : {}),
    ...(credentialId !== undefined ? { credentialId } : {}),
    ...(declaredVendor !== undefined ? { declaredVendor } : {}),
    ...(typeof harness === "string" ? { harness } : {}),
  };
}

export function mergeModelOverrides(
  task: TaskModelOverride | null,
  run: TaskModelOverride | null,
): TaskModelOverride | null {
  if (!task && !run) return null;
  const merged: TaskModelOverride = { ...(task ?? {}) };
  if (run?.maker) merged.maker = run.maker;
  if (run?.checker) merged.checker = run.checker;
  return merged;
}

export function parseTaskModelOverride(value: unknown): TaskModelOverride | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw invalid("models must be an object: { maker?, checker? }");
  }
  const fields = value as Record<string, unknown>;
  const unknownKeys = Object.keys(fields).filter((key) => key !== "maker" && key !== "checker");
  if (unknownKeys.length > 0) throw invalid(`models has no field ${unknownKeys.join(", ")}`);
  const override: TaskModelOverride = {};
  if (fields["maker"] !== undefined) override.maker = parseTaskChoice(fields["maker"], "maker");
  if (fields["checker"] !== undefined) {
    const list = Array.isArray(fields["checker"]) ? fields["checker"] : [fields["checker"]];
    if (list.length === 0 || list.length > 5) throw invalid("models.checker must name 1-5 models");
    override.checker = list.map((item) => parseTaskChoice(item, "checker"));
  }
  return override.maker || override.checker ? override : null;
}

function mapPolicyRow(row: Record<string, unknown>): ModelPolicyEntry {
  return {
    id: row["id"] as string,
    organizationId: row["organization_id"] as string,
    repositoryId: (row["repository_id"] as string | null) ?? null,
    role: row["role"] as ModelRole,
    provider: row["provider"] as string,
    model: row["model"] as string,
    credentialId: (row["credential_id"] as string | null) ?? null,
    declaredVendor: (row["declared_vendor"] as string | null) ?? null,
    harness: (row["harness"] as string | null | undefined) ?? null,
    createdAt: row["created_at"] as Date,
    updatedAt: row["updated_at"] as Date,
    updatedByPrincipalId: (row["updated_by_principal_id"] as string | null) ?? null,
  };
}

export async function listModelPolicies(
  db: Db,
  organizationId: string,
  options: { repositoryId?: string | null } = {},
): Promise<ModelPolicyEntry[]> {
  return (await selectModelPolicyRows(db, organizationId, options.repositoryId)).map(mapPolicyRow);
}

export interface PutModelPolicyInput {
  organizationId: string;

  repositoryId: string | null;
  role: string;
  provider?: string;
  model: string;

  credentialId?: string | null;
  declaredVendor?: string | null;

  harness?: string | null;

  enabledHarnesses?: readonly string[];
  updatedByPrincipalId?: string | null;
}

export async function putModelPolicy(db: Db, input: PutModelPolicyInput): Promise<ModelPolicyEntry> {
  if (input.role !== "maker" && input.role !== "checker") throw invalid("role must be maker or checker");
  const model = checkedModel(input.model);
  const declaredVendor = checkedVendor(input.declaredVendor) ?? null;
  const credentialId = checkedCredentialId(input.credentialId ?? null) ?? null;
  let credential: ModelCredential | null = null;
  if (credentialId !== null) {
    credential = await usableCredential(db, input.organizationId, credentialId);
  }
  const provider = checkedProvider(input.provider ?? credential?.provider);
  if (credential && credential.provider !== provider) {
    throw invalid(
      `model credential "${credential.label}" is for ${credential.provider}, not ${provider}`,
    );
  }

  deriveVendor(provider, model, declaredVendor ?? credential?.declaredVendor ?? undefined);
  const harness = checkedPolicyHarness(input.role, input.harness, input.enabledHarnesses);

  if (harness !== null) {
    const refusal = harnessProviderRefusal(harness, provider);
    if (refusal) throw new ModelPolicyError(422, "harness_incompatible", refusal);
  }

  const row = await upsertModelPolicyRow(db, {
    organizationId: input.organizationId,
    repositoryId: input.repositoryId,
    role: input.role,
    provider,
    model,
    credentialId,
    declaredVendor,
    updatedByPrincipalId: input.updatedByPrincipalId ?? null,
    harness,
  });
  return mapPolicyRow(row);
}

function checkedPolicyHarness(
  role: string,
  value: string | null | undefined,
  enabled: readonly string[] | undefined,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (role !== "maker") throw invalid("only the maker has a harness");
  if (typeof value !== "string" || !HARNESS_SHAPE.test(value)) {
    throw invalid("harness must be a harness id, like codex");
  }
  if (enabled && !enabled.includes(value)) {
    throw new ModelPolicyError(
      422,
      "harness_unavailable",
      `${value} is not a maker harness this deployment enables (it enables ${enabled.join(", ")}) (ADR-0027 §1)`,
    );
  }
  return value;
}

export async function deleteModelPolicy(
  db: Db,
  organizationId: string,
  repositoryId: string | null,
  role?: ModelRole,
): Promise<number> {
  return deleteModelPolicyRows(db, organizationId, repositoryId, role);
}

export interface OperatorModel {
  provider: ModelProvider;
  vendor: string;
  model: string;
  baseUrl?: string;
}

export interface OperatorModelDefaults {
  maker: OperatorModel;
  checker: OperatorModel[];
}

export function operatorProviderOf(endpoint: Pick<ModelEndpoint, "provider" | "vendor" | "baseUrl">): ModelProvider {
  if (endpoint.provider) return endpoint.provider;
  if (endpoint.vendor === "anthropic" && !endpoint.baseUrl) return "anthropic";
  if (endpoint.baseUrl) return endpoint.vendor === "openrouter" ? "openrouter" : "openai-compatible";
  return "openai";
}

function operatorVendor(identity: { vendor: string; provider?: ModelProvider; model: string }): string {
  try {
    return derivedVendor(identity) ?? identity.vendor;
  } catch {
    return identity.vendor;
  }
}

export function operatorModelDefaults(config: {
  makerModel: string;
  makerVendor: string;
  modelApiDomain: string;
  checkerModels: Pick<ModelPolicy, "endpoints">;
}): OperatorModelDefaults {
  const makerProvider =
    (Object.keys(PROVIDERS) as ModelProvider[]).find(
      (provider) => PROVIDERS[provider].egressHost === config.modelApiDomain,
    ) ?? "openai-compatible";
  return {
    maker: {
      provider: makerProvider,
      vendor: operatorVendor({ vendor: config.makerVendor, model: config.makerModel }),
      model: config.makerModel,
    },
    checker: config.checkerModels.endpoints.map((endpoint) => {
      const provider = operatorProviderOf(endpoint);
      return {
        provider,
        vendor: operatorVendor({ vendor: endpoint.vendor, provider, model: endpoint.model }),
        model: endpoint.model,
        ...(endpoint.baseUrl ? { baseUrl: endpoint.baseUrl } : {}),
      };
    }),
  };
}

export interface ResolveRunModelsInput {
  organizationId: string;
  repositoryId: string;
  taskOverride: TaskModelOverride | null;

  runOverride?: TaskModelOverride | null;
  operatorDefaults: OperatorModelDefaults;

  harnesses?: { versions: Readonly<Record<string, string>>; defaultId: string };

  worker?: string;
  now?: Date;
}

interface Layered {
  provider: ModelProvider;
  model: string;
  baseUrl?: string;
  credential?: ModelCredential;
  declaredVendor?: string;
  source: ChoiceSource;
}

export async function resolveRunModels(db: Db, input: ResolveRunModelsInput): Promise<RunModelConfig> {
  const { organizationId, operatorDefaults } = input;
  const rows = await listModelPolicies(db, organizationId, { repositoryId: input.repositoryId });
  const policyIds: string[] = [];
  const rowFor = (role: ModelRole): ModelPolicyEntry | undefined =>
    rows.find((row) => row.role === role && row.repositoryId !== null) ??
    rows.find((row) => row.role === role && row.repositoryId === null);

  const managed: Record<ModelRole, OperatorModel[]> = {
    maker: [operatorDefaults.maker],
    checker: operatorDefaults.checker,
  };

  const fromRow = async (row: ModelPolicyEntry): Promise<Layered> => {
    policyIds.push(row.id);
    return layered(db, organizationId, managed[row.role], {
      provider: row.provider,
      model: row.model,
      credentialId: row.credentialId,
      declaredVendor: row.declaredVendor ?? undefined,
      source: row.repositoryId === null ? "organization" : "repository",
      role: row.role,
    });
  };
  const fromOperator = (model: OperatorModel): Layered => ({
    provider: model.provider,
    model: model.model,
    ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),

    declaredVendor: model.vendor,
    source: "operator",
  });
  const fromTask = async (
    choice: TaskModelChoice,
    base: Layered | undefined,
    role: ModelRole,
    source: "task" | "run" = "task",
  ): Promise<Layered> => {
    if (choice.provider === undefined && choice.credentialId === undefined) {
      if (!base) {
        throw invalid(`the task names a ${role} model (${choice.model}) but no provider, and there is no ${role} to inherit one from`);
      }

      const { declaredVendor: _dropped, ...rest } = base;
      return {
        ...rest,
        model: choice.model,
        ...(choice.declaredVendor ? { declaredVendor: choice.declaredVendor } : {}),
        source,
      };
    }
    return layered(db, organizationId, managed[role], {
      provider: choice.provider ?? null,
      model: choice.model,
      credentialId: choice.credentialId ?? null,
      declaredVendor: choice.declaredVendor,
      source,
      role,
    });
  };

  const repoMakerRow = rows.find((row) => row.role === "maker" && row.repositoryId !== null);
  const orgMakerRow = rows.find((row) => row.role === "maker" && row.repositoryId === null);
  const registered = input.harnesses
    ? Object.keys(input.harnesses.versions)
    : input.worker
      ? [input.worker]
      : [];
  const requestedHarness =
    input.runOverride?.maker?.harness ??
    input.taskOverride?.maker?.harness ??
    repoMakerRow?.harness ??
    orgMakerRow?.harness ??
    undefined;
  if (requestedHarness && registered.length > 0 && !registered.includes(requestedHarness)) {
    throw new ModelPolicyError(
      422,
      "harness_unavailable",
      `the maker is asked to run on ${requestedHarness}, and this deployment drives the maker with ` +
        `${registered.join(", ")}; it will not run on another agent instead (ADR-0027 §1)`,
    );
  }
  const harnessId = requestedHarness ?? input.harnesses?.defaultId ?? input.worker;

  const makerRow = rowFor("maker");
  let maker: Layered = makerRow ? await fromRow(makerRow) : fromOperator(operatorDefaults.maker);
  if (input.taskOverride?.maker) maker = await fromTask(input.taskOverride.maker, maker, "maker");
  if (input.runOverride?.maker) maker = await fromTask(input.runOverride.maker, maker, "maker", "run");

  const checkerRow = rowFor("checker");
  let checker: Layered[] = checkerRow
    ? [await fromRow(checkerRow)]
    : operatorDefaults.checker.map(fromOperator);
  for (const [override, source] of [
    [input.taskOverride, "task"],
    [input.runOverride, "run"],
  ] as const) {
    if (!override?.checker) continue;
    const base = checker[0];
    checker = [];
    for (const choice of override.checker) checker.push(await fromTask(choice, base, "checker", source));
  }

  if (harnessId) {
    const refusal = harnessProviderRefusal(harnessId, maker.provider);
    if (refusal) throw new ModelPolicyError(422, "harness_incompatible", refusal);
  }

  const harness: RunHarnessChoice | undefined =
    input.harnesses && harnessId
      ? { id: harnessId, version: input.harnesses.versions[harnessId] ?? "unversioned" }
      : undefined;
  const worker = harness?.id ?? input.worker;
  return {
    version: 1,
    maker: { ...frozen(maker), ...(worker ? { worker } : {}), ...(harness ? { harness } : {}) },
    checker: checker.map(frozen),
    resolvedAt: (input.now ?? new Date()).toISOString(),
    policyIds,
  };
}

async function layered(
  db: Db,
  organizationId: string,
  managed: readonly OperatorModel[],
  choice: {
    provider: string | null;
    model: string;
    credentialId: string | null;
    declaredVendor: string | undefined;
    source: ChoiceSource;
    role: ModelRole;
  },
): Promise<Layered> {
  if (choice.credentialId !== null) {
    const credential = await usableCredential(db, organizationId, choice.credentialId);
    if (choice.provider !== null && choice.provider !== credential.provider) {
      throw invalid(
        `the ${choice.role} policy names provider ${choice.provider}, but model credential ` +
          `"${credential.label}" is for ${credential.provider}`,
      );
    }
    return {
      provider: checkedProvider(credential.provider),
      model: choice.model,
      ...(credential.baseUrl ? { baseUrl: credential.baseUrl } : {}),
      credential,
      ...(choice.declaredVendor ?? credential.declaredVendor
        ? { declaredVendor: (choice.declaredVendor ?? credential.declaredVendor)! }
        : {}),
      source: choice.source,
    };
  }

  const provider = checkedProvider(choice.provider ?? managed[0]?.provider);
  const operator = managed.find((model) => model.provider === provider);
  if (!operator) {
    throw new ModelPolicyError(
      422,
      "provider_not_managed",
      `the ${choice.role} policy asks for ${provider}/${choice.model} on Windkeel's key, and this ` +
        `deployment holds no Windkeel-managed ${provider} key for the ${choice.role}; attach a model credential`,
    );
  }
  return {
    provider,
    model: choice.model,
    ...(operator.baseUrl ? { baseUrl: operator.baseUrl } : {}),
    ...(choice.declaredVendor ? { declaredVendor: choice.declaredVendor } : {}),
    source: choice.source,
  };
}

export async function usableCredential(db: Db, organizationId: string, credentialId: string): Promise<ModelCredential> {
  const credential = await getModelCredential(db, organizationId, credentialId);
  if (!credential) {
    throw new ModelPolicyError(404, "credential_not_found", `model credential ${credentialId} does not exist in this organization`);
  }
  if (credential.revokedAt !== null || credential.status === "revoked") {
    throw new ModelPolicyError(409, "credential_revoked", `model credential "${credential.label}" is revoked`);
  }
  if (credential.status === "invalid") {
    throw new ModelPolicyError(
      409,
      "credential_invalid",
      `model credential "${credential.label}" is invalid` +
        (credential.statusReason ? ` (${credential.statusReason})` : "") +
        "; rotate it or choose another",
    );
  }
  return credential;
}

export function deriveVendor(provider: ModelProvider, model: string, declaredVendor: string | undefined): string {
  try {
    return vendorOf({ provider, model, declaredVendor });
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error));
  }
}

function frozen(choice: Layered): RunModelChoice {
  const vendor =
    choice.source === "operator"
      ? choice.declaredVendor ?? deriveVendor(choice.provider, choice.model, undefined)
      : deriveVendor(choice.provider, choice.model, choice.declaredVendor);
  return {
    provider: choice.provider,
    vendor,
    model: choice.model,
    ...(choice.baseUrl ? { baseUrl: choice.baseUrl } : {}),
    ...(choice.credential
      ? { credentialId: choice.credential.id, credentialLabel: choice.credential.label }
      : {}),
    ...(choice.declaredVendor && choice.source !== "operator" ? { declaredVendor: choice.declaredVendor } : {}),
    keySource: choice.credential ? "customer" : "orqon",
    source: choice.source,
  };
}

export function endpointOf(choice: RunModelChoice): ModelEndpoint {
  return {
    vendor: choice.vendor,
    provider: choice.provider,
    model: choice.model,
    apiKey: "",
    ...(choice.baseUrl ? { baseUrl: choice.baseUrl } : {}),
  };
}

export function makerIdentityOf(config: RunModelConfig): { vendor: string; model: string } {
  return { vendor: config.maker.vendor, model: config.maker.model };
}

export function chosenCheckerIndex(snapshot: RunModelConfig): number {
  const keyless = snapshot.checker.map(endpointOf);
  const { independent } = checkIndependence(makerIdentityOf(snapshot), keyless);
  return independent[0] ? keyless.indexOf(independent[0].endpoint) : -1;
}

export function independenceOf(config: RunModelConfig): string | null {
  if (config.checker.length === 0) return null;
  return independenceReason(makerIdentityOf(config), config.checker.map(endpointOf));
}

export function independenceReason(
  maker: { vendor: string; model: string },
  checkers: readonly ModelEndpoint[],
): string | null {
  const { makerVendor, independent, rejected } = checkIndependence(maker, checkers);
  if (independent.length > 0) return null;
  return (
    `no checker model is independent of the maker (${makerVendor ?? maker.vendor}/` +
    `${maker.model}): ${rejected.map((r) => r.reason).join("; ")} (ADR-0010, ADR-0026 §5)`
  );
}

const CUSTOMER_KEY_ROLES: ReadonlySet<ModelRole> = new Set<ModelRole>(["maker", "checker"]);

export function unwiredCustomerKey(
  config: RunModelConfig,
  wired: ReadonlySet<ModelRole> = CUSTOMER_KEY_ROLES,
): string | null {
  const uses: Array<[ModelRole, RunModelChoice]> = [
    ["maker", config.maker],
    ...config.checker.map((choice): [ModelRole, RunModelChoice] => ["checker", choice]),
  ];
  for (const [role, choice] of uses) {
    if (choice.keySource === "customer" && !wired.has(role)) {
      return (
        `the ${role} is set to model credential "${choice.credentialLabel ?? choice.credentialId}", ` +
        `and this deployment cannot yet use an organization's own key for the ${role}; ` +
        "it will not run on Windkeel's key instead (ADR-0026 §6)"
      );
    }
  }
  return null;
}
