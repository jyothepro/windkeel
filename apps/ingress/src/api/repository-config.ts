import type { Page } from "@windkeel/api-contract";
import { grantedRepository } from "@windkeel/factory/tenancy";
import { type ApiDeps, type ApiError, type ApiResult, type Scope, accepted, audited, badRequest, conflict, notFound, ok, stringField } from "./common.js";

export async function repositorySecrets(
  deps: ApiDeps,
  scope: Scope,
  repositoryId: string,
): Promise<ApiResult> {
  const repository = await grantedRepository(deps.pool, scope.organizationId, repositoryId);
  if (!repository) return notFound("repository");
  const { listRepositorySecrets } = await import(
    "@windkeel/factory/repositories"
  );
  const items = await listRepositorySecrets(deps.pool, scope.organizationId, repositoryId);
  return ok({ items, endCursor: null, hasNextPage: false } satisfies Page<unknown>);
}

export async function createRepositorySecret(
  deps: ApiDeps,
  scope: Scope,
  repositoryId: string,
  body: unknown,
): Promise<ApiResult> {
  const repository = await grantedRepository(deps.pool, scope.organizationId, repositoryId);
  if (!repository) return notFound("repository");

  if (!deps.secretPublicKey) {
    return {
      status: 503,
      body: {
        error:
          "WINDKEEL_SECRET_PUBLIC_KEY is not set, so this deployment cannot seal a secret. " +
          "Run `windkeel-admin secrets keygen` and set the public half here and the private half on " +
          "the worker.",
        code: "secrets_disabled",
      } satisfies ApiError,
    };
  }

  const key = stringField(body, "key");
  const value = stringField(body, "value");
  if (!key || !value) return badRequest("key and value are required", "missing_field");
  const note = stringField(body, "note") ?? null;

  const { putRepositorySecret } = await import("@windkeel/factory/repositories");
  const publicKey = deps.secretPublicKey;

  const stored = await audited(
    deps,
    scope,
    (tx) =>
      putRepositorySecret(tx, {
        organizationId: scope.organizationId,
        repositoryId,
        key,
        value,
        note,
        setBy: scope.actor,
        setByPrincipalId: scope.principalId,
        publicKey,
      }),
    () => ({ action: "secret.set", target: { type: "repository", id: repositoryId }, detail: { key } }),
  );

  return ok(stored);
}

export async function deleteRepositorySecret(
  deps: ApiDeps,
  scope: Scope,
  repositoryId: string,
  key: string,
): Promise<ApiResult> {
  const repository = await grantedRepository(deps.pool, scope.organizationId, repositoryId);
  if (!repository) return notFound("repository");
  const { deleteRepositorySecret: remove } = await import(
    "@windkeel/factory/repositories"
  );
  const removed = await audited(
    deps,
    scope,
    (tx) => remove(tx, scope.organizationId, repositoryId, key),
    (done) => (done ? { action: "secret.deleted", target: { type: "repository", id: repositoryId }, detail: { key } } : null),
  );
  return removed ? ok({ deleted: key }) : notFound(`secret ${key}`);
}

export async function repositoryEnvironment(
  deps: ApiDeps,
  scope: Scope,
  repositoryId: string,
): Promise<ApiResult> {
  const repository = await grantedRepository(deps.pool, scope.organizationId, repositoryId);
  if (!repository) return notFound("repository");
  const { listSnapshots, pendingSnapshotRequest } = await import(
    "@windkeel/factory/repositories"
  );
  const rows = await listSnapshots(deps.pool, scope.organizationId, repositoryId);
  const items = rows.map((s) => ({
    id: s.id,
    status: s.status,
    sandboxProvider: s.sandboxProvider,
    cacheKey: s.cacheKey,
    baseSha: s.baseSha,
    sizeBytes: s.sizeBytes,
    detail: s.detail,
    setupLogRef: s.setupLogRef,
    builtBy: s.builtBy,
    createdAt: s.createdAt,
    readyAt: s.readyAt,
    expiresAt: s.expiresAt,
    lastUsedAt: s.lastUsedAt,
  }));
  const proposal = rows.find((s) => s.proposedSetup)?.proposedSetup ?? null;
  return ok({
    items,
    current: items.find((s) => s.status === "ready") ?? null,
    pendingRequest: await pendingSnapshotRequest(deps.pool, scope.organizationId, repositoryId),
    proposedSetup: proposal,
    endCursor: null,
    hasNextPage: false,
  });
}

export async function rebuildRepositoryEnvironment(
  deps: ApiDeps,
  scope: Scope,
  repositoryId: string,
): Promise<ApiResult> {
  const repository = await grantedRepository(deps.pool, scope.organizationId, repositoryId);
  if (!repository) return notFound("repository");
  const { requestSnapshotBuild } = await import("@windkeel/factory/repositories");

  if (deps.environmentBuilds) {
    try {
      await deps.environmentBuilds.request(scope.organizationId, repositoryId);
      return accepted({ repositoryId, requested: "rebuild", started: true });
    } catch {

    }
  }
  await requestSnapshotBuild(deps.pool, {
    organizationId: scope.organizationId,
    repositoryId,
    requestedBy: scope.actor,
    reason: `rebuild requested by ${scope.actor}`,
  });
  return accepted({ repositoryId, requested: "rebuild", started: false });
}

export async function invalidateRepositoryEnvironment(
  deps: ApiDeps,
  scope: Scope,
  repositoryId: string,
): Promise<ApiResult> {
  const repository = await grantedRepository(deps.pool, scope.organizationId, repositoryId);
  if (!repository) return notFound("repository");
  const { invalidateSnapshots } = await import("@windkeel/factory/repositories");
  const invalidated = await invalidateSnapshots(
    deps.pool,
    repositoryId,
    `invalidated by ${scope.actor}`,
    scope.organizationId,
  );
  return ok({ repositoryId, invalidated });
}

export async function refusedCredential(
  deps: ApiDeps,
  scope: Scope,
  override: { maker?: { credentialId?: string | null }; checker?: Array<{ credentialId?: string | null }> },
): Promise<ApiResult | null> {
  const { getModelCredential } = await import("@windkeel/factory/models");
  const ids = [override.maker, ...(override.checker ?? [])]
    .map((choice) => choice?.credentialId)
    .filter((id): id is string => typeof id === "string");
  for (const id of ids) {
    const credential = await getModelCredential(deps.pool, scope.organizationId, id);
    if (!credential) return notFound(`model credential ${id}`);
    if (credential.revokedAt) return conflict(`model credential "${credential.label}" is revoked`, "credential_revoked");
  }
  return null;
}
