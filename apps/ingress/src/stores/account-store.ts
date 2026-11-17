import type { Pool, PoolClient } from "pg";

type Db = Pool | PoolClient;
type Row = Record<string, unknown>;

export async function organizationAccountId(db: Db, organizationId: string): Promise<string> {
  const { rows } = await db.query("select account_id from organization where id = $1", [organizationId]);
  return rows[0]!["account_id"] as string;
}

export async function defaultAccountId(db: Db): Promise<string | undefined> {
  const { rows } = await db.query("select id from account where is_default");
  return rows[0]?.["id"] as string | undefined;
}

export async function accessReviewPrincipals(db: Db, accountId: string): Promise<Row[]> {
  const { rows } = await db.query(
    `select p.id, p.kind, p.display_name, p.github_login, p.is_bootstrap, p.deactivated_at, p.organization_id,
            (select max(i.last_seen_at) from user_identity i where i.principal_id = p.id) as last_sign_in_at,
            (select r.key from account_membership am join access_role r on r.id = am.access_role_id
              where am.principal_id = p.id) as account_role
       from principal p
      where p.account_id = $1
      order by p.kind, p.display_name, p.id`,
    [accountId],
  );
  return rows;
}

export async function accessReviewMemberships(db: Db, accountId: string): Promise<Row[]> {
  const { rows } = await db.query(
    `select m.principal_id, o.id, o.name, r.key as role
       from membership m join organization o on o.id = m.organization_id join access_role r on r.id = m.access_role_id
      where o.account_id = $1 order by o.name`,
    [accountId],
  );
  return rows;
}

export async function accessReviewLiveTokens(db: Db, accountId: string): Promise<Row[]> {
  const { rows } = await db.query(
    `select t.* from api_token t join principal p on p.id = t.owner_principal_id
      where p.account_id = $1 and t.revoked_at is null and (t.expires_at is null or t.expires_at > now())
      order by t.created_at`,
    [accountId],
  );
  return rows;
}
