import type { Pool } from "pg";
import { recordAuditEvent, withTransaction, type AuditContext } from "../audit-log.js";
import { type Queryable, isUuid } from "./common.js";
import { MembershipError } from "./members.js";
import { ADMIN_PERMISSIONS, type Permission, isPermission } from "./permissions.js";
import { type Principal, rowToPrincipal } from "./principals.js";
import { UnknownRoleError, resolveRole } from "./roles.js";
import { type ApiToken, TokenScopeError, createApiToken, listTokens, revokeToken } from "./tokens.js";
import {
  deactivatePrincipal,
  deleteMembershipsOf,
  ensureBuiltinMemberMembership,
  insertMembership,
  insertServicePrincipal,
  insertSystemActor,
  revokeAllTokensOf,
  selectLiveServicePrincipals,
  selectRolePermissions,
  selectServicePrincipal,
  selectSystemActor,
} from "./stores/service-principal-store.js";

export interface ServicePrincipal {
  id: string;
  organizationId: string;
  displayName: string;

  role: string | null;

  permissions: Permission[];

  systemPurpose: string | null;
  createdAt: Date;
  deactivatedAt: Date | null;
}

export class ServicePrincipalError extends Error {
  override readonly name = "ServicePrincipalError";
}

function rowToServicePrincipal(row: Record<string, unknown>): ServicePrincipal {
  return {
    id: row["id"] as string,
    organizationId: row["organization_id"] as string,
    displayName: row["display_name"] as string,
    role: (row["role"] as string | null) ?? null,
    permissions: (row["permissions"] as string[]).filter(isPermission),
    systemPurpose: (row["system_purpose"] as string | null) ?? null,
    createdAt: row["created_at"] as Date,
    deactivatedAt: (row["deactivated_at"] as Date | null) ?? null,
  };
}

export async function listServicePrincipals(db: Queryable, organizationId: string): Promise<ServicePrincipal[]> {
  return (await selectLiveServicePrincipals(db, organizationId)).map(rowToServicePrincipal);
}

async function getServicePrincipal(
  db: Queryable,
  organizationId: string,
  id: string,
): Promise<ServicePrincipal | null> {
  if (!isUuid(id)) return null;
  const row = await selectServicePrincipal(db, organizationId, id);
  return row ? rowToServicePrincipal(row) : null;
}

export async function createServicePrincipal(
  pool: Pool,
  input: {
    organizationId: string;
    name: string;
    role: string;
    createdByPrincipalId: string;
    ceiling: readonly Permission[];
    audit?: AuditContext | undefined;
  },
): Promise<ServicePrincipal> {
  const name = input.name.trim();
  if (name === "" || name.length > 100) {
    throw new ServicePrincipalError("a service principal needs a name of 1 to 100 characters");
  }
  let roleId: string;
  try {
    roleId = (await resolveRole(pool, input.organizationId, input.role)).id;
  } catch (err) {
    if (err instanceof MembershipError || err instanceof UnknownRoleError) throw new ServicePrincipalError(err.message);
    throw err;
  }
  const beyond = (await selectRolePermissions(pool, roleId)).filter(
    (p) => isPermission(p) && !input.ceiling.includes(p),
  );
  if (beyond.length > 0) {
    throw new TokenScopeError(
      `you cannot make a ${input.role} service principal: it would hold ${beyond.join(", ")}, which you do not`,
    );
  }

  const id = await withTransaction(pool, async (client) => {
    const id = await insertServicePrincipal(client, input.organizationId, name);
    if (!id) throw new ServicePrincipalError("no such organization");
    await insertMembership(client, input.organizationId, id, roleId);
    if (input.audit) {
      await recordAuditEvent(client, {
        organizationId: input.organizationId,
        ...input.audit,
        action: "service_principal.created",
        target: { type: "principal", id },
        detail: { name, role: input.role },
      });
    }
    return id;
  });
  return (await getServicePrincipal(pool, input.organizationId, id))!;
}

export async function deleteServicePrincipal(
  pool: Pool,
  organizationId: string,
  id: string,
  audit?: AuditContext,
): Promise<ServicePrincipal | null> {
  const existing = await getServicePrincipal(pool, organizationId, id);
  if (!existing || existing.deactivatedAt) return null;
  if (existing.systemPurpose !== null) {
    throw new ServicePrincipalError("an organization's built-in system actor cannot be deleted");
  }
  await withTransaction(pool, async (client) => {
    await revokeAllTokensOf(client, id);
    await deleteMembershipsOf(client, id);
    await deactivatePrincipal(client, id);
    if (audit) {
      await recordAuditEvent(client, {
        organizationId,
        ...audit,
        action: "service_principal.deleted",
        target: { type: "principal", id },
        detail: { name: existing.displayName },
      });
    }
  });
  return getServicePrincipal(pool, organizationId, id);
}

export async function createServiceToken(
  db: Queryable,
  input: {
    organizationId: string;
    servicePrincipalId: string;
    name: string;
    createdByPrincipalId: string;
    ceiling: readonly Permission[];
    permissions?: Permission[] | undefined;
    expiresAt?: Date | undefined;
  },
): Promise<{ token: ApiToken; secret: string } | null> {
  const principal = await getServicePrincipal(db, input.organizationId, input.servicePrincipalId);
  if (!principal || principal.deactivatedAt) return null;
  const permissions =
    input.permissions ??
    principal.permissions.filter((p) => !ADMIN_PERMISSIONS.includes(p) && input.ceiling.includes(p));
  if (permissions.length === 0) {
    throw new TokenScopeError("that token could do nothing; give it permissions that its role and you both hold");
  }
  const outsideRole = permissions.filter((p) => !principal.permissions.includes(p));
  if (outsideRole.length > 0) {
    throw new TokenScopeError(`this service principal's role does not include ${outsideRole.join(", ")}`);
  }
  return createApiToken(db, {
    name: input.name,
    ownerPrincipalId: principal.id,
    createdByPrincipalId: input.createdByPrincipalId,
    organizationId: principal.organizationId,
    permissions,
    ceiling: input.ceiling,
    expiresAt: input.expiresAt,
  });
}

export async function listServiceTokens(
  db: Queryable,
  organizationId: string,
  servicePrincipalId: string,
): Promise<ApiToken[] | null> {
  const principal = await getServicePrincipal(db, organizationId, servicePrincipalId);
  if (!principal) return null;
  return listTokens(db, principal.id);
}

export async function revokeServiceToken(
  db: Queryable,
  organizationId: string,
  servicePrincipalId: string,
  tokenId: string,
): Promise<ApiToken | null> {
  if (!isUuid(tokenId)) return null;
  const principal = await getServicePrincipal(db, organizationId, servicePrincipalId);
  if (!principal) return null;
  return revokeToken(db, principal.id, tokenId);
}

const SYSTEM_PURPOSE = /^[a-z][a-z0-9_.-]{0,62}$/;

export async function getSystemActor(db: Queryable, organizationId: string, purpose: string): Promise<Principal> {
  if (!SYSTEM_PURPOSE.test(purpose)) {
    throw new ServicePrincipalError(`a system actor's purpose is a lower-case word, not ${JSON.stringify(purpose)}`);
  }
  const found = async (): Promise<Principal | null> => {
    const row = await selectSystemActor(db, organizationId, purpose);
    return row ? rowToPrincipal(row) : null;
  };
  let principal = await found();
  if (!principal) {
    const row = await insertSystemActor(db, organizationId, purpose, `Windkeel ${purpose}`);
    principal = row ? rowToPrincipal(row) : await found();
    if (!principal) throw new ServicePrincipalError("no such organization");
  }

  await ensureBuiltinMemberMembership(db, organizationId, principal.id);
  return principal;
}
