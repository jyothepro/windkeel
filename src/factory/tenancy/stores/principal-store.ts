
import type { Queryable } from "../common.js";

type Row = Record<string, unknown>;

export async function selectPrincipal(db: Queryable, id: string): Promise<Row | undefined> {
  const { rows } = await db.query("select * from principal where id = $1", [id]);
  return rows[0];
}

export async function selectBootstrapPrincipal(db: Queryable): Promise<Row | undefined> {
  const { rows } = await db.query("select * from principal where is_bootstrap");
  return rows[0];
}

export async function selectAccount(db: Queryable, id: string): Promise<Row | undefined> {
  const { rows } = await db.query("select id, name from account where id = $1", [id]);
  return rows[0];
}

export async function selectOrganizationAccess(db: Queryable, principalId: string): Promise<Row[]> {
  const { rows } = await db.query(
    `select o.id, o.name,
            mr.key as member_role,
            coalesce(mr.permissions, '{}') as member_permissions,
            coalesce(ar.permissions, '{}') as account_permissions
       from principal p
       join organization o on o.account_id = p.account_id
       left join membership m on m.organization_id = o.id and m.principal_id = p.id
       left join access_role mr on mr.id = m.access_role_id
       left join account_membership am on am.account_id = p.account_id and am.principal_id = p.id
       left join access_role ar on ar.id = am.access_role_id
      where p.id = $1 and (m.id is not null or am.id is not null)
      order by o.is_default desc, o.name asc`,
    [principalId],
  );
  return rows;
}

export async function lockOrganizationAccess(db: Queryable, principalId: string, organizationId: string): Promise<void> {
  await db.query(
    `select m.id from membership m join access_role r on r.id = m.access_role_id
      where m.principal_id = $1 and m.organization_id = $2
        for share of m, r`,
    [principalId, organizationId],
  );
  await db.query(
    `select am.id from account_membership am
       join organization o on o.account_id = am.account_id
       join access_role r on r.id = am.access_role_id
      where am.principal_id = $1 and o.id = $2
        for share of am, r`,
    [principalId, organizationId],
  );
}

export async function accountMembershipExists(db: Queryable, principalId: string): Promise<boolean> {
  const { rows } = await db.query(
    "select 1 from account_membership where principal_id = $1",
    [principalId],
  );
  return rows.length > 0;
}

export async function selectAccountRole(db: Queryable, principalId: string): Promise<Row | undefined> {
  const { rows } = await db.query(
    `select r.id, r.key, r.name, r.permissions from account_membership am
       join access_role r on r.id = am.access_role_id
      where am.principal_id = $1`,
    [principalId],
  );
  return rows[0];
}

export async function countAccountOrganizations(db: Queryable, accountId: string): Promise<number> {
  const { rows } = await db.query("select count(*) as n from organization where account_id = $1", [
    accountId,
  ]);
  return Number(rows[0]?.["n"] ?? 0);
}
