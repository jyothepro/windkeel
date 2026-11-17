import { type Queryable, isUuid } from "./common.js";
import { type Permission } from "./permissions.js";
import { assertRoleWithin, resolveRole } from "./roles.js";
import {
  countOtherAdmins,
  deleteMembership,
  deletePendingInvitation,
  isOrganizationAdmin,
  revokeOrganizationTokensOf,
  selectInvitations,
  selectMembers,
  updateMemberRole,
  upsertInvitation,
} from "./stores/member-store.js";

export interface Member {
  principalId: string;
  displayName: string;
  githubLogin: string | null;
  role: string;
  createdAt: Date;
}

export async function listMembers(db: Queryable, organizationId: string): Promise<Member[]> {
  return (await selectMembers(db, organizationId)).map((row) => ({
    principalId: row["id"] as string,
    displayName: row["display_name"] as string,
    githubLogin: (row["github_login"] as string | null) ?? null,
    role: row["role"] as string,
    createdAt: row["created_at"] as Date,
  }));
}

export class MembershipError extends Error {
  override readonly name = "MembershipError";
}

export const ROLE_KEYS = ["admin", "member", "viewer"] as const;

export async function setMemberRole(
  db: Queryable,
  organizationId: string,
  principalId: string,
  role: string,
  ceiling?: readonly Permission[],
): Promise<Member | null> {
  const resolved = await resolveRole(db, organizationId, role);
  assertRoleWithin(resolved, ceiling);
  const roleId = resolved.id;
  if (!(resolved.builtIn && resolved.key === "admin")) await assertAnotherAdmin(db, organizationId, principalId);
  if (!(await updateMemberRole(db, organizationId, principalId, roleId))) return null;
  return (await listMembers(db, organizationId)).find((m) => m.principalId === principalId) ?? null;
}

export async function removeMember(db: Queryable, organizationId: string, principalId: string): Promise<boolean> {
  if (!isUuid(principalId)) return false;
  await assertAnotherAdmin(db, organizationId, principalId);
  if (!(await deleteMembership(db, organizationId, principalId))) return false;

  await revokeOrganizationTokensOf(db, principalId, organizationId);
  return true;
}

async function assertAnotherAdmin(db: Queryable, organizationId: string, principalId: string): Promise<void> {
  const otherAdmins = await countOtherAdmins(db, organizationId, principalId);
  const isAdmin = await isOrganizationAdmin(db, organizationId, principalId);
  if (isAdmin && otherAdmins === 0) {
    throw new MembershipError("that would leave the organization with no admin");
  }
}

export interface Invitation {
  id: string;
  githubLogin: string;
  role: string;
  invitedBy: string | null;

  invitedByName: string | null;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
}

const INVITATION_DAYS = 14;

export async function listInvitations(db: Queryable, organizationId: string): Promise<Invitation[]> {
  return (await selectInvitations(db, organizationId)).map((row) => ({
    id: row["id"] as string,
    githubLogin: row["github_login"] as string,
    role: row["role"] as string,
    invitedBy: (row["invited_by_principal_id"] as string | null) ?? null,
    invitedByName: (row["invited_by_name"] as string | null) ?? null,
    createdAt: row["created_at"] as Date,
    expiresAt: row["expires_at"] as Date,
    acceptedAt: (row["accepted_at"] as Date | null) ?? null,
  }));
}

export async function createInvitation(
  db: Queryable,
  input: {
    organizationId: string;
    githubUserId: number;
    githubLogin: string;
    role: string;
    invitedByPrincipalId: string;

    ceiling?: readonly Permission[] | undefined;
  },
): Promise<Invitation> {
  const resolved = await resolveRole(db, input.organizationId, input.role);
  assertRoleWithin(resolved, input.ceiling);
  const roleId = resolved.id;
  const id = await upsertInvitation(db, {
    organizationId: input.organizationId,
    githubUserId: input.githubUserId,
    githubLogin: input.githubLogin,
    roleId,
    invitedByPrincipalId: input.invitedByPrincipalId,
    days: INVITATION_DAYS,
  });
  return (await listInvitations(db, input.organizationId)).find((i) => i.id === id)!;
}

export async function deleteInvitation(db: Queryable, organizationId: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  return deletePendingInvitation(db, organizationId, id);
}
