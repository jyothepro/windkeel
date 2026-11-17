import {
  deleteModelPolicy as storeDelete,
  listModelPolicies,
  putModelPolicy,
  type ModelPolicyEntry,
} from "@windkeel/factory/models";
import {
  createModelPreset as storeCreatePreset,
  deleteModelPreset as storeDeletePreset,
  listModelPresets,
  updateModelPreset as storeUpdatePreset,
  type ModelPreset,
  type ModelPresetInput,
} from "@windkeel/factory/models";
import { grantedRepository } from "@windkeel/factory/tenancy";
import { auditOf, audited, badRequest, harnessesOf, notFound, ok, type ApiDeps, type ApiResult, type Query, type Scope } from "./handlers.js";
import { recordAuditEvent } from "@windkeel/factory/tenancy";
import { transact } from "./transact.js";

function modelPolicyView(entry: ModelPolicyEntry) {
  return {
    id: entry.id,
    repositoryId: entry.repositoryId,
    role: entry.role,
    provider: entry.provider,
    model: entry.model,
    credentialId: entry.credentialId,
    keySource: entry.credentialId ? "customer" : "orqon",
    declaredVendor: entry.declaredVendor,
    harness: entry.harness,
    updatedByPrincipalId: entry.updatedByPrincipalId,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

export async function modelPolicy(deps: ApiDeps, scope: Scope, query: Query): Promise<ApiResult> {
  const repositoryId = await scopedRepository(deps, scope, query);
  if (typeof repositoryId === "object" && repositoryId !== null) return repositoryId;
  const [items, presets] = await Promise.all([
    listModelPolicies(deps.pool, scope.organizationId, { repositoryId }),
    listModelPresets(deps.pool, scope.organizationId),
  ]);
  return ok({
    repositoryId,
    items: items.map(modelPolicyView),
    presets: presets.map(modelPresetView),
    harnesses: harnessesOf(deps).map(({ id, label, default: isDefault }) => ({ id, label, default: isDefault })),
  });
}

function modelPresetView(preset: ModelPreset) {
  return {
    id: preset.id,
    name: preset.name,
    harness: preset.harness,
    maker: preset.maker,
    checker: preset.checker,
    createdByPrincipalId: preset.createdByPrincipalId,
    createdAt: preset.createdAt.toISOString(),
    updatedAt: preset.updatedAt.toISOString(),
  };
}

const presetBody = (body: unknown): ModelPresetInput => {
  const fields = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  return { name: fields["name"], harness: fields["harness"], maker: fields["maker"], checker: fields["checker"] };
};

export async function modelPresets(deps: ApiDeps, scope: Scope): Promise<ApiResult> {
  const presets = await listModelPresets(deps.pool, scope.organizationId);
  return ok({ items: presets.map(modelPresetView) });
}

export async function createModelPreset(deps: ApiDeps, scope: Scope, body: unknown): Promise<ApiResult> {
  const preset = await audited(
    deps,
    scope,
    (tx) =>
      storeCreatePreset(tx, scope.organizationId, presetBody(body), {
        enabledHarnesses: harnessesOf(deps).map((h) => h.id),
        createdByPrincipalId: scope.principalId,
      }),
    (done) => ({ action: "model_preset.created", target: { type: "model_preset", id: done.id }, detail: { name: done.name } }),
  );
  return { status: 201, body: { preset: modelPresetView(preset) } };
}

export async function updateModelPreset(deps: ApiDeps, scope: Scope, presetId: string, body: unknown): Promise<ApiResult> {
  const preset = await audited(
    deps,
    scope,
    (tx) =>
      storeUpdatePreset(tx, scope.organizationId, presetId, presetBody(body), {
        enabledHarnesses: harnessesOf(deps).map((h) => h.id),
      }),
    (done) => (done ? { action: "model_preset.updated", target: { type: "model_preset", id: presetId }, detail: { name: done.name } } : null),
  );
  return preset ? ok({ preset: modelPresetView(preset) }) : notFound("model preset");
}

export async function deleteModelPreset(deps: ApiDeps, scope: Scope, presetId: string): Promise<ApiResult> {
  const deleted = await audited(
    deps,
    scope,
    (tx) => storeDeletePreset(tx, scope.organizationId, presetId),
    (done) => (done ? { action: "model_preset.deleted", target: { type: "model_preset", id: presetId } } : null),
  );
  return deleted ? ok({ deleted: presetId }) : notFound("model preset");
}

export async function setModelPolicy(deps: ApiDeps, scope: Scope, query: Query, body: unknown): Promise<ApiResult> {
  const repositoryId = await scopedRepository(deps, scope, query);
  if (typeof repositoryId === "object" && repositoryId !== null) return repositoryId;
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const roles = (["maker", "checker"] as const).filter((role) => fields[role] !== undefined);
  if (roles.length === 0) return badRequest("give maker, checker, or both: { model, provider?, credentialId? }", "missing_field");

  return transact(deps.pool, async (client, rollback: (answer: ApiResult) => never) => {
    const items: ModelPolicyEntry[] = [];
    for (const role of roles) {
      const choice = fields[role];
      if (typeof choice !== "object" || choice === null || Array.isArray(choice)) {
        return rollback(badRequest(`${role} must be an object: { model, provider?, credentialId?, declaredVendor? }`, "invalid_model_policy"));
      }
      const c = choice as Record<string, unknown>;
      const harness = c["harness"];
      if (harness !== undefined && harness !== null && typeof harness !== "string") {
        return rollback(badRequest(`${role}.harness must be a harness id, like codex`, "invalid_model_policy"));
      }
      items.push(
        await putModelPolicy(client, {
          organizationId: scope.organizationId,
          repositoryId,
          role,
          ...(typeof c["provider"] === "string" ? { provider: c["provider"] } : {}),
          model: typeof c["model"] === "string" ? c["model"] : "",
          credentialId: typeof c["credentialId"] === "string" ? c["credentialId"] : null,
          declaredVendor: typeof c["declaredVendor"] === "string" ? c["declaredVendor"] : null,
          harness: typeof harness === "string" ? harness : null,
          enabledHarnesses: harnessesOf(deps).map((h) => h.id),
          updatedByPrincipalId: scope.principalId,
        }),
      );
    }
    await recordAuditEvent(client, {
      organizationId: scope.organizationId,
      ...auditOf(scope),
      action: "model_policy.set",
      target: repositoryId ? { type: "repository", id: repositoryId } : { type: "organization", id: scope.organizationId },
      detail: { roles, models: items.map((i) => ({ role: i.role, model: i.model, credentialId: i.credentialId })) },
    });
    return ok({ repositoryId, items: items.map(modelPolicyView) });
  });
}

export async function deleteModelPolicy(deps: ApiDeps, scope: Scope, query: Query): Promise<ApiResult> {
  const repositoryId = await scopedRepository(deps, scope, query);
  if (typeof repositoryId === "object" && repositoryId !== null) return repositoryId;
  const role = query.get("role") ?? undefined;
  if (role !== undefined && role !== "maker" && role !== "checker") {
    return badRequest("role must be maker or checker", "invalid_model_policy");
  }
  const deleted = await audited(
    deps,
    scope,
    (tx) => storeDelete(tx, scope.organizationId, repositoryId, role),
    (count) =>
      count
        ? {
            action: "model_policy.deleted",
            target: repositoryId ? { type: "repository", id: repositoryId } : { type: "organization", id: scope.organizationId },
            detail: { role: role ?? null, deleted: count },
          }
        : null,
  );
  return ok({ repositoryId, deleted });
}

async function scopedRepository(deps: ApiDeps, scope: Scope, query: Query): Promise<string | null | ApiResult> {
  const repositoryId = query.get("repositoryId");
  if (!repositoryId) return null;
  const repository = await grantedRepository(deps.pool, scope.organizationId, repositoryId);
  return repository ? repositoryId : notFound("repository");
}
