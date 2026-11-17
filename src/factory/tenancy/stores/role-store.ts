
import type { Queryable } from "../common.js";

type Row = Record<string, unknown>;

export async function selectVisibleRoles(db: Queryable, accountId: string): Promise<Row[]> {
  const { rows } = await db.query(
    `select * from access_role
      where (account_id is null or account_id = $1) and deleted_at is null
      order by account_id is not null, case key when 'admin' then 0 when 'member' then 1 when 'viewer' then 2 else 3 end, name`,
    [accountId],
  );
  return rows;
}

export async function selectVisibleRole(db: Queryable, accountId: string, roleId: string): Promise<Row | undefined> {
  const { rows } = await db.query(
    "select * from access_role where id = $1 and (account_id is null or account_id = $2) and deleted_at is null",
    [roleId, accountId],
  );
  return rows[0];
}

export async function selectRoleForOrganization(db: Queryable, organizationId: string, role: string): Promise<Row | undefined> {
  const { rows } = await db.query(
    `select r.* from access_role r, organization o
      where o.id = $1 and r.deleted_at is null
        and (r.account_id is null or r.account_id = o.account_id)
        and (r.key = $2 or r.id::text = $2)
      order by r.account_id is not null
      limit 1`,
    [organizationId, role],
  );
  return rows[0];
}

export async function insertRole(
  db: Queryable,
  input: {
    accountId: string;
    key: string;
    name: string;
    description: string | null;
    permissions: readonly string[];
    createdByPrincipalId: string;
  },
): Promise<Row> {
  const { rows } = await db.query(
    `insert into access_role (account_id, key, name, description, permissions, created_by_principal_id)
     values ($1, $2, $3, $4, $5, $6) returning *`,
    [input.accountId, input.key, input.name, input.description, input.permissions, input.createdByPrincipalId],
  );
  return rows[0]!;
}

export async function updateAccountRole(
  db: Queryable,
  input: { roleId: string; accountId: string; name: string; description: string | null; permissions: readonly string[] },
): Promise<Row | undefined> {
  const { rows } = await db.query(
    `update access_role set name = $3, description = $4, permissions = $5, updated_at = now()
      where id = $1 and account_id = $2 and deleted_at is null returning *`,
    [input.roleId, input.accountId, input.name, input.description, input.permissions],
  );
  return rows[0];
}

export async function countRoleUses(db: Queryable, roleId: string): Promise<{ holders: number; pending: number }> {
  const { rows } = await db.query(
    `select (select count(*) from membership where access_role_id = $1)
          + (select count(*) from account_membership where access_role_id = $1) as holders,
            (select count(*) from invitation where access_role_id = $1 and accepted_at is null and expires_at > now()) as pending`,
    [roleId],
  );
  return { holders: Number(rows[0]!["holders"]), pending: Number(rows[0]!["pending"]) };
}

export async function markRoleDeleted(db: Queryable, accountId: string, roleId: string): Promise<void> {
  await db.query("update access_role set deleted_at = now(), updated_at = now() where id = $1 and account_id = $2", [roleId, accountId]);
}
