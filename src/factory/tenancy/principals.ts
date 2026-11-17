import { type Queryable } from "./common.js";
import { type Permission, isPermission } from "./permissions.js";
import {
  accountMembershipExists,
  countAccountOrganizations,
  lockOrganizationAccess,
  selectAccount,
  selectAccountRole,
  selectBootstrapPrincipal,
  selectOrganizationAccess,
  selectPrincipal,
} from "./stores/principal-store.js";

export interface Principal {
  id: string;
  accountId: string;
  kind: "user" | "token";
  displayName: string;
  githubUserId: number | null;
  githubLogin: string | null;
  isBootstrap: boolean;

  organizationId: string | null;

  deactivatedAt: Date | null;
}

export interface OrganizationAccess {
  id: string;
  name: string;

  role: string | null;

  permissions: Permission[];
}

export function rowToPrincipal(row: Record<string, unknown>): Principal {
  return {
    id: row["id"] as string,
    accountId: row["account_id"] as string,
    kind: row["kind"] as Principal["kind"],
    displayName: row["display_name"] as string,
    githubUserId: row["github_user_id"] === null ? null : Number(row["github_user_id"]),
    githubLogin: (row["github_login"] as string | null) ?? null,
    isBootstrap: row["is_bootstrap"] as boolean,
    organizationId: (row["organization_id"] as string | null | undefined) ?? null,
    deactivatedAt: (row["deactivated_at"] as Date | null | undefined) ?? null,
  };
}

export async function getPrincipal(db: Queryable, id: string): Promise<Principal | null> {
  const row = await selectPrincipal(db, id);
  return row ? rowToPrincipal(row) : null;
}

export async function getBootstrapPrincipal(db: Queryable): Promise<Principal | null> {
  const row = await selectBootstrapPrincipal(db);
  return row ? rowToPrincipal(row) : null;
}

export async function getAccount(db: Queryable, id: string): Promise<{ id: string; name: string } | null> {
  const row = await selectAccount(db, id);
  return row ? { id: row["id"] as string, name: row["name"] as string } : null;
}

export async function organizationsFor(db: Queryable, principalId: string): Promise<OrganizationAccess[]> {
  return (await selectOrganizationAccess(db, principalId)).map((row) => ({
    id: row["id"] as string,
    name: row["name"] as string,
    role: (row["member_role"] as string | null) ?? null,
    permissions: [
      ...new Set([
        ...(row["member_permissions"] as string[]),
        ...(row["account_permissions"] as string[]),
      ]),
    ].filter(isPermission),
  }));
}

export async function lockedOrganizationAccess(
  db: Queryable,
  principalId: string,
  organizationId: string,
): Promise<OrganizationAccess | null> {
  await lockOrganizationAccess(db, principalId, organizationId);
  return (await organizationsFor(db, principalId)).find((org) => org.id === organizationId) ?? null;
}

export async function hasAccountRole(db: Queryable, principalId: string): Promise<boolean> {
  return accountMembershipExists(db, principalId);
}

export async function accountRoleOf(
  db: Queryable,
  principalId: string,
): Promise<{ id: string; key: string; name: string; permissions: Permission[] } | null> {
  const row = await selectAccountRole(db, principalId);
  if (!row) return null;
  return {
    id: row["id"] as string,
    key: row["key"] as string,
    name: row["name"] as string,
    permissions: (row["permissions"] as string[]).filter(isPermission),
  };
}

export async function countOrganizations(db: Queryable, accountId: string): Promise<number> {
return countAccountOrganizations(db, accountId);
}
