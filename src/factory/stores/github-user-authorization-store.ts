
import type { Queryable } from "../db/transaction.js";

type Row = Record<string, unknown>;

export async function selectGithubUserAuthorizationRow(db: Queryable, columns: string, principalId: string): Promise<Row | undefined> {
  const { rows } = await db.query(`select ${columns} from github_user_authorization where principal_id = $1`, [principalId]);
  return rows[0];
}

export interface GithubUserAuthorizationUpsert {
  principalId: string;
  githubUserId: number;
  githubLogin: string;
  sealedAccess: string;
  sealedRefresh: string | null;
  keypairId: string;
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
}

export async function upsertGithubUserAuthorizationRow(db: Queryable, columns: string, v: GithubUserAuthorizationUpsert): Promise<Row> {
  const { rows } = await db.query(
    `insert into github_user_authorization
       (principal_id, github_user_id, github_login, sealed_access_token, sealed_refresh_token, keypair_id,
        access_expires_at, refresh_expires_at, status, status_reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'valid', null)
     on conflict (principal_id) do update set
       github_user_id = excluded.github_user_id, github_login = excluded.github_login,
       sealed_access_token = excluded.sealed_access_token, sealed_refresh_token = excluded.sealed_refresh_token,
       keypair_id = excluded.keypair_id, access_expires_at = excluded.access_expires_at,
       refresh_expires_at = excluded.refresh_expires_at, status = 'valid', status_reason = null,
       updated_at = now(), refreshed_at = null
     returning ${columns}`,
    [v.principalId, v.githubUserId, v.githubLogin, v.sealedAccess, v.sealedRefresh, v.keypairId, v.accessExpiresAt, v.refreshExpiresAt],
  );
  return rows[0]!;
}

export async function deleteGithubUserAuthorizationRow(db: Queryable, principalId: string): Promise<number> {
  const { rowCount } = await db.query("delete from github_user_authorization where principal_id = $1", [principalId]);
  return rowCount ?? 0;
}

export async function updateGithubUserAuthorizationNeedsReauth(db: Queryable, principalId: string, reason: string): Promise<void> {
  await db.query(
    `update github_user_authorization set status = 'needs_reauth', status_reason = $2, updated_at = now()
      where principal_id = $1`,
    [principalId, reason],
  );
}

export async function selectSealedGithubUserAuthorizationForUpdate(db: Queryable, principalId: string): Promise<Row | undefined> {
  const { rows } = await db.query(
    `select github_user_id, github_login, sealed_access_token, sealed_refresh_token, status,
            access_expires_at, refresh_expires_at
       from github_user_authorization where principal_id = $1 for update`,
    [principalId],
  );
  return rows[0] as Row | undefined;
}

export interface GithubUserTokenRefresh {
  sealedAccess: string;

  sealedRefresh: string | null;
  keypairId: string;
  accessExpiresAt: Date | null;

  refreshExpiresAt: Date | null;
}

export async function updateRefreshedGithubUserTokens(db: Queryable, principalId: string, v: GithubUserTokenRefresh): Promise<void> {
  await db.query(
    `update github_user_authorization set
       sealed_access_token = $2, sealed_refresh_token = coalesce($3, sealed_refresh_token), keypair_id = $4,
       access_expires_at = $5, refresh_expires_at = coalesce($6, refresh_expires_at),
       refreshed_at = now(), updated_at = now()
     where principal_id = $1`,
    [principalId, v.sealedAccess, v.sealedRefresh, v.keypairId, v.accessExpiresAt, v.refreshExpiresAt],
  );
}
