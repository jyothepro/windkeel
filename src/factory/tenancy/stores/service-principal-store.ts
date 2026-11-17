
import type { Queryable } from "../common.js";

type Row = Record<string, unknown>;

const SERVICE_PRINCIPAL_SELECT = `
  select p.id, p.organization_id, p.display_name, p.system_purpose, p.created_at, p.deactivated_at,
         r.key as role, coalesce(r.permissions, '{}') as permissions
    from principal p
    left join membership m on m.principal_id = p.id and m.organization_id = p.organization_id
    left join access_role r on r.id = m.access_role_id`;

export async function selectLiveServicePrincipals(db: Queryable, organizationId: string): Promise<Row[]> {
  const { rows } = await db.query(
    `${SERVICE_PRINCIPAL_SELECT}
      where p.kind = 'token' and p.organization_id = $1 and p.deactivated_at is null
      order by p.created_at, p.id`,
    [organizationId],
  );
  return rows;
}

export async function selectServicePrincipal(db: Queryable, organizationId: string, id: string): Promise<Row | undefined> {
  const { rows } = await db.query(
    `${SERVICE_PRINCIPAL_SELECT}
      where p.kind = 'token' and p.organization_id = $1 and p.id = $2`,
    [organizationId, id],
  );
  return rows[0];
}

export async function selectRolePermissions(db: Queryable, roleId: string): Promise<string[]> {
  const { rows } = await db.query("select permissions from access_role where id = $1", [roleId]);
  return rows[0]!["permissions"] as string[];
}

export async function insertServicePrincipal(db: Queryable, organizationId: string, name: string): Promise<string | undefined> {
  const { rows } = await db.query(
    `insert into principal (account_id, kind, display_name, organization_id)
     select account_id, 'token', $2, id from organization where id = $1
     returning id`,
    [organizationId, name],
  );
  return rows[0]?.["id"] as string | undefined;
}

export async function insertMembership(db: Queryable, organizationId: string, principalId: string, roleId: string): Promise<void> {
  await db.query(
    `insert into membership (organization_id, principal_id, access_role_id) values ($1, $2, $3)`,
    [organizationId, principalId, roleId],
  );
}

export async function revokeAllTokensOf(db: Queryable, principalId: string): Promise<void> {
  await db.query(
    "update api_token set revoked_at = now() where owner_principal_id = $1 and revoked_at is null",
    [principalId],
  );
}

export async function deleteMembershipsOf(db: Queryable, principalId: string): Promise<void> {
  await db.query("delete from membership where principal_id = $1", [principalId]);
}

export async function deactivatePrincipal(db: Queryable, principalId: string): Promise<void> {
  await db.query(
    "update principal set deactivated_at = now(), updated_at = now() where id = $1 and deactivated_at is null",
    [principalId],
  );
}

export async function selectSystemActor(db: Queryable, organizationId: string, purpose: string): Promise<Row | undefined> {
  const { rows } = await db.query(
    "select * from principal where organization_id = $1 and system_purpose = $2",
    [organizationId, purpose],
  );
  return rows[0];
}

export async function insertSystemActor(
  db: Queryable,
  organizationId: string,
  purpose: string,
  displayName: string,
): Promise<Row | undefined> {
  const { rows } = await db.query(
    `insert into principal (account_id, kind, display_name, organization_id, system_purpose)
     select account_id, 'token', $3, id, $2 from organization where id = $1
     on conflict (organization_id, system_purpose) where system_purpose is not null do nothing
     returning *`,
    [organizationId, purpose, displayName],
  );
  return rows[0];
}

export async function ensureBuiltinMemberMembership(db: Queryable, organizationId: string, principalId: string): Promise<void> {
  await db.query(
    `insert into membership (organization_id, principal_id, access_role_id)
     select $1, $2, id from access_role where key = 'member' and account_id is null
     on conflict (organization_id, principal_id) do nothing`,
    [organizationId, principalId],
  );
}
