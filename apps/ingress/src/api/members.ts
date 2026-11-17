import type { Page } from "@windkeel/api-contract";
import { createInvitation as storeInvitation, deleteGrant as removeGrant, deleteInvitation as removeInvitation, isUuid, listGrants, listInvitations, listMembers, putGrant, removeMember as storeRemoveMember, resolveScope, setMemberRole as storeSetRole, createServicePrincipal as storeCreateServicePrincipal, createServiceToken as storeCreateServiceToken, deleteServicePrincipal as storeDeleteServicePrincipal, listServicePrincipals, listServiceTokens, revokeServiceToken as storeRevokeServiceToken, type ServicePrincipal } from "@windkeel/factory/tenancy";
import { type ApiDeps, type ApiError, type ApiResult, type Scope, auditOf, audited, badRequest, field, notFound, ok, stringField } from "./common.js";
import { tokenAuditDetail, tokenView } from "./tokens.js";

export async function members(deps: ApiDeps, scope: Scope): Promise<ApiResult> {
  const items = await listMembers(deps.pool, scope.organizationId);
  return ok({ items, endCursor: null, hasNextPage: false } satisfies Page<unknown>);
}

export async function setMemberRole(
  deps: ApiDeps,
  scope: Scope,
  principalId: string,
  body: unknown,
): Promise<ApiResult> {
  const role = stringField(body, "role");
  if (!role) return badRequest("role is required", "missing_field");
  if (!isUuid(principalId)) return notFound("member");
  const changed = await audited(
    deps,
    scope,
    async (tx) => {
      const before = (await listMembers(tx, scope.organizationId)).find((m) => m.principalId === principalId);
      const after = await storeSetRole(tx, scope.organizationId, principalId, role, scope.permissions);
      return { before, after };
    },
    ({ before, after }) =>
      after
        ? { action: "member.role_changed", target: { type: "principal", id: principalId }, detail: { from: before?.role ?? null, to: after.role } }
        : null,
  );
  return changed.after ? ok({ member: changed.after }) : notFound("member");
}

export async function removeMember(deps: ApiDeps, scope: Scope, principalId: string): Promise<ApiResult> {
  const removed = await audited(
    deps,
    scope,
    (tx) => storeRemoveMember(tx, scope.organizationId, principalId),
    (done) => (done ? { action: "member.removed", target: { type: "principal", id: principalId } } : null),
  );
  return removed ? ok({ removed: principalId }) : notFound("member");
}

export async function invitations(deps: ApiDeps, scope: Scope): Promise<ApiResult> {
  const items = await listInvitations(deps.pool, scope.organizationId);
  return ok({ items, endCursor: null, hasNextPage: false } satisfies Page<unknown>);
}

export async function createInvitation(deps: ApiDeps, scope: Scope, body: unknown): Promise<ApiResult> {
  const login = stringField(body, "githubLogin")?.trim().replace(/^@/, "");
  if (!login) return badRequest("githubLogin is required", "missing_field");
  const role = stringField(body, "role") ?? "member";
  if (!deps.githubUsers) {
    return {
      status: 503,
      body: { error: "this deployment cannot look up GitHub accounts", code: "github_unconfigured" } satisfies ApiError,
    };
  }
  const user = await deps.githubUsers.lookup(login);
  if (!user) return { status: 404, body: { error: `no GitHub account ${login}`, code: "github_user_not_found" } };
  const invitation = await audited(
    deps,
    scope,
    (tx) =>
      storeInvitation(tx, {
        organizationId: scope.organizationId,
        githubUserId: user.id,
        githubLogin: user.login,
        role,
        invitedByPrincipalId: scope.principalId,
        ceiling: scope.permissions,
      }),
    (created) => ({
      action: "invitation.created",
      target: { type: "invitation", id: created.id },
      detail: { githubLogin: created.githubLogin, githubUserId: user.id, role: created.role },
    }),
  );
  return { status: 201, body: { invitation } };
}

export async function deleteInvitation(deps: ApiDeps, scope: Scope, invitationId: string): Promise<ApiResult> {
  const removed = await audited(
    deps,
    scope,
    (tx) => removeInvitation(tx, scope.organizationId, invitationId),
    (done) => (done ? { action: "invitation.deleted", target: { type: "invitation", id: invitationId } } : null),
  );
  return removed ? ok({ deleted: invitationId }) : notFound("invitation");
}

export async function grants(deps: ApiDeps, scope: Scope): Promise<ApiResult> {
  const items = await listGrants(deps.pool, scope.organizationId);
  return ok({ items, endCursor: null, hasNextPage: false } satisfies Page<unknown>);
}

export async function createGrant(deps: ApiDeps, scope: Scope, body: unknown): Promise<ApiResult> {
  const repositoryId = stringField(body, "repositoryId");
  if (!repositoryId || !isUuid(repositoryId)) return badRequest("repositoryId is required", "missing_field");
  const grant = await putGrant(deps.pool, {
    organizationId: scope.organizationId,
    repositoryId,
    intake: field(body, "intake") === true,
    createdByPrincipalId: scope.principalId,
    audit: auditOf(scope),
  });
  return ok({ grant });
}

export async function deleteGrant(deps: ApiDeps, scope: Scope, repositoryId: string): Promise<ApiResult> {
  const removed = await audited(
    deps,
    scope,
    (tx) => removeGrant(tx, scope.organizationId, repositoryId),
    (done) => (done ? { action: "grant.deleted", target: { type: "repository", id: repositoryId } } : null),
  );
  return removed ? ok({ deleted: repositoryId }) : notFound("grant");
}

function servicePrincipalView(principal: ServicePrincipal) {
  return {
    id: principal.id,
    kind: "service",
    organizationId: principal.organizationId,
    displayName: principal.displayName,
    role: principal.role,
    permissions: principal.permissions,
    system: principal.systemPurpose !== null,
    systemPurpose: principal.systemPurpose,
    createdAt: principal.createdAt,
    deactivatedAt: principal.deactivatedAt,
  };
}

export async function servicePrincipals(deps: ApiDeps, scope: Scope): Promise<ApiResult> {
  const items = await listServicePrincipals(deps.pool, scope.organizationId);
  return ok({ items: items.map(servicePrincipalView), endCursor: null, hasNextPage: false } satisfies Page<unknown>);
}

export async function createServicePrincipal(deps: ApiDeps, scope: Scope, body: unknown): Promise<ApiResult> {
  const name = stringField(body, "name");
  if (!name) return badRequest("name is required", "missing_field");
  const role = stringField(body, "role") ?? "member";
  const principal = await storeCreateServicePrincipal(deps.pool, {
    organizationId: scope.organizationId,
    name,
    role,
    createdByPrincipalId: scope.principalId,
    ceiling: scope.permissions ?? [],
    audit: auditOf(scope),
  });
  return { status: 201, body: { servicePrincipal: servicePrincipalView(principal) } };
}

export async function deleteServicePrincipal(deps: ApiDeps, scope: Scope, principalId: string): Promise<ApiResult> {
  const deleted = await storeDeleteServicePrincipal(deps.pool, scope.organizationId, principalId, auditOf(scope));
  return deleted ? ok({ deleted: principalId, servicePrincipal: servicePrincipalView(deleted) }) : notFound("service principal");
}

export async function serviceTokens(deps: ApiDeps, scope: Scope, principalId: string): Promise<ApiResult> {
  const items = await listServiceTokens(deps.pool, scope.organizationId, principalId);
  if (!items) return notFound("service principal");
  return ok({ items: items.map(tokenView), endCursor: null, hasNextPage: false } satisfies Page<unknown>);
}

export async function createServiceToken(
  deps: ApiDeps,
  scope: Scope,
  principalId: string,
  body: unknown,
): Promise<ApiResult> {
  const name = stringField(body, "name");
  if (!name) return badRequest("name is required", "missing_field");
  const preset = field(body, "preset");
  const listed = field(body, "permissions");
  const permissions =
    preset === undefined && listed === undefined ? undefined : resolveScope({ preset, permissions: listed });
  const rawExpiry = field(body, "expiresAt");
  let expiresAt: Date | undefined;
  if (rawExpiry !== undefined && rawExpiry !== null) {
    expiresAt = typeof rawExpiry === "string" ? new Date(rawExpiry) : new Date(Number.NaN);
    if (Number.isNaN(expiresAt.getTime())) return badRequest("expiresAt must be an ISO 8601 time", "invalid_scope");
  }
  const created = await audited(
    deps,
    scope,
    (tx) =>
      storeCreateServiceToken(tx, {
        organizationId: scope.organizationId,
        servicePrincipalId: principalId,
        name,
        createdByPrincipalId: scope.principalId,
        ceiling: scope.permissions ?? [],
        permissions,
        expiresAt,
      }),
    (minted) =>
      minted
        ? { action: "token.created", target: { type: "token", id: minted.token.id }, detail: { ...tokenAuditDetail(minted.token), servicePrincipalId: principalId } }
        : null,
  );
  if (!created) return notFound("service principal");
  return { status: 201, body: { token: tokenView(created.token), secret: created.secret } };
}

export async function revokeServiceToken(
  deps: ApiDeps,
  scope: Scope,
  principalId: string,
  tokenId: string,
): Promise<ApiResult> {
  const revoked = await audited(
    deps,
    scope,
    (tx) => storeRevokeServiceToken(tx, scope.organizationId, principalId, tokenId),
    (token) =>
      token ? { action: "token.revoked", target: { type: "token", id: token.id }, detail: { ...tokenAuditDetail(token), servicePrincipalId: principalId } } : null,
  );
  return revoked ? ok({ token: tokenView(revoked) }) : notFound("token");
}
