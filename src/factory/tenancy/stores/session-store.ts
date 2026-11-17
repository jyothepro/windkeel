
import type { Queryable } from "../common.js";

type Row = Record<string, unknown>;

export async function selectIdentityLink(
  db: Queryable,
  provider: string,
  subject: string,
): Promise<{ principalId: string; githubUserId: unknown } | null> {
  const { rows } = await db.query(
    `select i.principal_id, p.github_user_id
       from user_identity i join principal p on p.id = i.principal_id
      where i.provider = $1 and i.subject = $2`,
    [provider, subject],
  );
  const principalId = rows[0]?.["principal_id"] as string | undefined;
  return principalId ? { principalId, githubUserId: rows[0]!["github_user_id"] } : null;
}

export async function touchIdentity(db: Queryable, provider: string, subject: string): Promise<void> {
  await db.query(`update user_identity set last_seen_at = now() where provider = $1 and subject = $2`, [
    provider,
    subject,
  ]);
}

export async function lockPendingInvitations(db: Queryable, githubUserId: number): Promise<Row[]> {
  const { rows } = await db.query(
    `select i.id, o.account_id from invitation i
       join organization o on o.id = i.organization_id
      where i.github_user_id = $1 and i.accepted_at is null and i.expires_at > now()
      order by i.created_at
      for update of i`,
    [githubUserId],
  );
  return rows;
}

export async function selectPrincipalByGithubUser(db: Queryable, githubUserId: number): Promise<Row | undefined> {
  const { rows } = await db.query("select * from principal where github_user_id = $1", [githubUserId]);
  return rows[0];
}

export async function insertUserPrincipal(
  db: Queryable,
  input: { accountId: unknown; displayName: string; githubUserId: number; githubLogin: string | null },
): Promise<Row> {
  const { rows } = await db.query(
    `insert into principal (account_id, kind, display_name, github_user_id, github_login)
     values ($1, 'user', $2, $3, $4) returning *`,
    [input.accountId, input.displayName, input.githubUserId, input.githubLogin],
  );
  return rows[0]!;
}

export async function linkIdentity(db: Queryable, principalId: string, provider: string, subject: string): Promise<void> {
  await db.query(
    `insert into user_identity (principal_id, provider, subject, last_seen_at)
     values ($1, $2, $3, now()) on conflict (provider, subject) do nothing`,
    [principalId, provider, subject],
  );
}

export async function hasPendingInvitation(db: Queryable, githubUserId: number): Promise<boolean> {
  const { rows } = await db.query(
    "select 1 from invitation where github_user_id = $1 and accepted_at is null and expires_at > now() limit 1",
    [githubUserId],
  );
  return rows.length > 0;
}

export async function acceptPendingInvitations(db: Queryable, principalId: string, githubUserId: number): Promise<Row[]> {
  const { rows } = await db.query(
    `with accepted as (
       update invitation set accepted_at = now(), accepted_by_principal_id = $1
        where github_user_id = $2 and accepted_at is null and expires_at > now()
        returning id, organization_id, access_role_id
     ), joined as (
       insert into membership (organization_id, principal_id, access_role_id)
         select organization_id, $1, access_role_id from accepted
       on conflict (organization_id, principal_id) do nothing
     )
     select a.id, a.organization_id, r.key as role, p.github_login, p.display_name
       from accepted a
       join access_role r on r.id = a.access_role_id
       join principal p on p.id = $1`,
    [principalId, githubUserId],
  );
  return rows;
}
