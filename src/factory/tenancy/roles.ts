import { type Queryable, isUuid } from "./common.js";
import { ROLE_KEYS } from "./members.js";
import { PERMISSIONS, type Permission, isPermission } from "./permissions.js";
import { TokenScopeError } from "./tokens.js";
import {
  countRoleUses,
  insertRole,
  markRoleDeleted,
  selectRoleForOrganization,
  selectVisibleRole,
  selectVisibleRoles,
  updateAccountRole,
} from "./stores/role-store.js";

export interface AccessRole {
  id: string;
  key: string;
  name: string;
  description: string | null;
  permissions: Permission[];

  builtIn: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class UnknownRoleError extends Error {
  override readonly name = "UnknownRoleError";
}

export class RoleError extends Error {
  override readonly name = "RoleError";
}

export class BuiltinRoleError extends Error {
  override readonly name = "BuiltinRoleError";
}

export class RoleInUseError extends Error {
  override readonly name = "RoleInUseError";
}

function rowToRole(row: Record<string, unknown>): AccessRole {
  return {
    id: row["id"] as string,
    key: row["key"] as string,
    name: row["name"] as string,
    description: (row["description"] as string | null) ?? null,
    permissions: (row["permissions"] as string[]).filter(isPermission),
    builtIn: row["account_id"] === null,
    createdBy: (row["created_by_principal_id"] as string | null) ?? null,
    createdAt: row["created_at"] as Date,
    updatedAt: row["updated_at"] as Date,
  };
}

export async function listRoles(db: Queryable, accountId: string): Promise<AccessRole[]> {
  return (await selectVisibleRoles(db, accountId)).map(rowToRole);
}

async function getRole(db: Queryable, accountId: string, roleId: string): Promise<AccessRole | null> {
  if (!isUuid(roleId)) return null;
  const row = await selectVisibleRole(db, accountId, roleId);
  return row ? rowToRole(row) : null;
}

export async function resolveRole(db: Queryable, organizationId: string, role: string): Promise<AccessRole> {
  const row = await selectRoleForOrganization(db, organizationId, role);
  if (!row) {
    throw new UnknownRoleError(
      `unknown role ${JSON.stringify(role)}; use one of ${ROLE_KEYS.join(", ")}, or a custom role's key or id`,
    );
  }
  return rowToRole(row);
}

const ROLE_KEY = /^[a-z][a-z0-9-]{1,39}$/;

function slugFor(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function rolePermissions(raw: unknown, ceiling: readonly Permission[]): Permission[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new RoleError("permissions must be a non-empty list");
  const unknown = raw.filter((p) => typeof p !== "string" || !isPermission(p));
  if (unknown.length > 0) {
    throw new RoleError(`unknown permission ${JSON.stringify(unknown[0])}; use any of ${PERMISSIONS.join(", ")}`);
  }
  const permissions = [...new Set(raw as Permission[])];

  const beyond = permissions.filter((p) => !ceiling.includes(p));
  if (beyond.length > 0) {
    throw new TokenScopeError(`you cannot make a role with ${beyond.join(", ")}, which you do not hold`);
  }
  return PERMISSIONS.filter((p) => permissions.includes(p));
}

function roleText(raw: unknown, field: string, max: number, required: boolean): string | null {
  if (raw === undefined || raw === null) {
    if (required) throw new RoleError(`${field} is required`);
    return null;
  }
  if (typeof raw !== "string" || raw.trim() === "" || raw.trim().length > max) {
    throw new RoleError(`${field} must be 1 to ${max} characters`);
  }
  return raw.trim();
}

export async function createRole(
  db: Queryable,
  input: {
    accountId: string;
    key?: unknown;
    name: unknown;
    description?: unknown;
    permissions: unknown;
    createdByPrincipalId: string;
    ceiling: readonly Permission[];
  },
): Promise<AccessRole> {
  const name = roleText(input.name, "name", 80, true)!;
  const description = roleText(input.description, "description", 500, false);
  const key = input.key === undefined ? slugFor(name) : input.key;
  if (typeof key !== "string" || !ROLE_KEY.test(key)) {
    throw new RoleError("key must be 2 to 40 lower-case letters, digits and hyphens, starting with a letter");
  }
  if ((ROLE_KEYS as readonly string[]).includes(key)) throw new RoleError(`${key} is a built-in role's key`);
  const permissions = rolePermissions(input.permissions, input.ceiling);
  try {
    return rowToRole(
      await insertRole(db, {
        accountId: input.accountId,
        key,
        name,
        description,
        permissions,
        createdByPrincipalId: input.createdByPrincipalId,
      }),
    );
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new RoleError(`this account already has a role with key ${key}`);
    throw err;
  }
}

export async function updateRole(
  db: Queryable,
  input: {
    accountId: string;
    roleId: string;
    name?: unknown;
    description?: unknown;
    permissions?: unknown;
    ceiling: readonly Permission[];
  },
): Promise<{ before: AccessRole; after: AccessRole } | null> {
  const before = await getRole(db, input.accountId, input.roleId);
  if (!before) return null;
  if (before.builtIn) throw new BuiltinRoleError(`${before.name} is a built-in role and cannot be changed`);
  const name = input.name === undefined ? before.name : roleText(input.name, "name", 80, true)!;
  const description = input.description === undefined ? before.description : roleText(input.description, "description", 500, false);
  const permissions = input.permissions === undefined ? before.permissions : rolePermissions(input.permissions, input.ceiling);
  const row = await updateAccountRole(db, { roleId: input.roleId, accountId: input.accountId, name, description, permissions });
  return row ? { before, after: rowToRole(row) } : null;
}

export async function deleteRole(db: Queryable, accountId: string, roleId: string): Promise<AccessRole | null> {
  const role = await getRole(db, accountId, roleId);
  if (!role) return null;
  if (role.builtIn) throw new BuiltinRoleError(`${role.name} is a built-in role and cannot be deleted`);
  const { holders, pending } = await countRoleUses(db, roleId);
  if (holders > 0 || pending > 0) {
    throw new RoleInUseError(
      `${role.name} is held by ${holders} and offered by ${pending} pending invitation${pending === 1 ? "" : "s"}; move them to another role first`,
    );
  }
  await markRoleDeleted(db, accountId, roleId);
  return role;
}

export function assertRoleWithin(role: AccessRole, ceiling: readonly Permission[] | undefined): void {
  if (!ceiling) return;
  const beyond = role.permissions.filter((p) => !ceiling.includes(p));
  if (beyond.length > 0) {
    throw new TokenScopeError(`you cannot give the ${role.name} role: it holds ${beyond.join(", ")}, which you do not`);
  }
}
