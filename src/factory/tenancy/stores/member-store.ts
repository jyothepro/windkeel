
import type { Queryable } from "../common.js";

type Row = Record<string, unknown>;

export async function selectMembers(db: Queryable, organizationId: string): Promise<Row[]> {
  const { rows } = await db.query(
    `select p.id, p.display_name, p.github_login, r.key as role, m.created_at
       from membership m
       join principal p on p.id = m.principal_id
       join access_role r on r.id = m.access_role_id
      where m.organization_id = $1 and p.kind = 'user'
      order by p.display_name`,
    [organizationId],
  );
  return rows;
}

export async function updateMemberRole(
  db: Queryable,
  organizationId: string,
  principalId: string,
  roleId: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `update membership set access_role_id = $3, updated_at = now()
      where organization_id = $1 and principal_id = $2
        and principal_id in (select id from principal where kind = 'user')`,
    [organizationId, principalId, roleId],
  );
  return Boolean(rowCount);
}

export async function deleteMembership(db: Queryable, organizationId: string, principalId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `delete from membership where organization_id = $1 and principal_id = $2
        and principal_id in (select id from principal where kind = 'user')`,
    [organizationId, principalId],
  );
  return (rowCount ?? 0) > 0;
}

export async function revokeOrganizationTokensOf(db: Queryable, principalId: string, organizationId: string): Promise<void> {
  await db.query(
    `update api_token set revoked_at = now()
      where owner_principal_id = $1 and organization_id = $2 and revoked_at is null`,
    [principalId, organizationId],
  );
}

export async function countOtherAdmins(db: Queryable, organizationId: string, principalId: string): Promise<number> {
  const { rows } = await db.query(
    `select count(*) as n from membership m
       join access_role r on r.id = m.access_role_id
       join principal p on p.id = m.principal_id and p.kind = 'user'
      where m.organization_id = $1 and r.key = 'admin' and r.account_id is null and m.principal_id <> $2`,
    [organizationId, principalId],
  );
  return Number(rows[0]!["n"]);
}

export async function isOrganizationAdmin(db: Queryable, organizationId: string, principalId: string): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from membership m join access_role r on r.id = m.access_role_id
      where m.organization_id = $1 and m.principal_id = $2 and r.key = 'admin' and r.account_id is null`,
    [organizationId, principalId],
  );
  return rows.length > 0;
}

export async function selectInvitations(db: Queryable, organizationId: string): Promise<Row[]> {
  const { rows } = await db.query(
    `select i.*, r.key as role, coalesce(p.github_login, p.display_name) as invited_by_name
       from invitation i
       join access_role r on r.id = i.access_role_id
       left join principal p on p.id = i.invited_by_principal_id
      where i.organization_id = $1 order by i.created_at desc`,
    [organizationId],
  );
  return rows;
}

export async function upsertInvitation(
  db: Queryable,
  input: {
    organizationId: string;
    githubUserId: number;
    githubLogin: string;
    roleId: string;
    invitedByPrincipalId: string;
    days: number;
  },
): Promise<string> {
  const { rows } = await db.query(
    `insert into invitation
       (organization_id, github_user_id, github_login, access_role_id, invited_by_principal_id, expires_at)
     values ($1, $2, $3, $4, $5, now() + make_interval(days => ${input.days}))
     on conflict (organization_id, github_user_id) where accepted_at is null do update
       set github_login = excluded.github_login,
           access_role_id = excluded.access_role_id,
           invited_by_principal_id = excluded.invited_by_principal_id,
           expires_at = excluded.expires_at
     returning id`,
    [input.organizationId, input.githubUserId, input.githubLogin, input.roleId, input.invitedByPrincipalId],
  );
  return rows[0]!["id"] as string;
}

export async function deletePendingInvitation(db: Queryable, organizationId: string, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "delete from invitation where organization_id = $1 and id = $2 and accepted_at is null",
    [organizationId, id],
  );
  return (rowCount ?? 0) > 0;
}
