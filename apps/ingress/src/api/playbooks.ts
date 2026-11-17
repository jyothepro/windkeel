import {
  archivePlaybook as storeArchive,
  createPlaybook as storeCreate,
  describePlaybookVerifier,
  getPlaybook,
  listPlaybooks,
  playbookCriteria,
  unknownPlaybook,
  updatePlaybook as storeUpdate,
  type Playbook,
} from "@windkeel/factory/repositories";
import { ok, type ApiDeps, type ApiResult, type Scope } from "./handlers.js";

function playbookView(p: Playbook) {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    kind: p.kind,
    version: p.version,
    builtin: p.builtin,
    makerInstructions: p.makerInstructions,
    criteria: p.criteria,
    verifier: p.verifier,
    defaultRiskLevel: p.defaultRiskLevel,
    modelPresetId: p.modelPresetId,
    verifierAdds: describePlaybookVerifier(p.verifier),
    addedCriteria: playbookCriteria(p).map((c) => ({ id: c.id, text: c.text })),
  };
}

export async function playbooks(deps: ApiDeps, scope: Scope): Promise<ApiResult> {
  const items = await listPlaybooks(deps.pool, scope.organizationId);
  return ok({ items: items.map(playbookView) });
}

export async function playbook(deps: ApiDeps, scope: Scope, slugOrId: string): Promise<ApiResult> {
  const found = await getPlaybook(deps.pool, scope.organizationId, slugOrId);
  if (!found) throw unknownPlaybook(slugOrId);
  return ok({ playbook: playbookView(found) });
}

export async function createPlaybook(deps: ApiDeps, scope: Scope, body: unknown): Promise<ApiResult> {
  const created = await storeCreate(deps.pool, scope.organizationId, body ?? {}, { createdByPrincipalId: scope.principalId });
  return { status: 201, body: { playbook: playbookView(created) } };
}

export async function updatePlaybook(deps: ApiDeps, scope: Scope, slugOrId: string, body: unknown): Promise<ApiResult> {
  const updated = await storeUpdate(deps.pool, scope.organizationId, slugOrId, body ?? {});
  return ok({ playbook: playbookView(updated) });
}

export async function archivePlaybook(deps: ApiDeps, scope: Scope, slugOrId: string): Promise<ApiResult> {
  const archived = await storeArchive(deps.pool, scope.organizationId, slugOrId);
  return ok({ archived: archived.id, slug: archived.slug });
}
