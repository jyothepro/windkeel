
import type { Queryable } from "../common.js";

type Row = Record<string, unknown>;

export async function insertApiToken(
  db: Queryable,
  input: {
    name: string;
    ownerPrincipalId: string;
    createdByPrincipalId: string;
    organizationId: string | null;
    permissions: readonly string[];
    prefix: string;
    hash: string;
    expiresAt: Date | string | null;
  },
): Promise<Row> {
  const { rows } = await db.query(
    `insert into api_token
       (name, owner_principal_id, created_by_principal_id, organization_id, permissions,
        prefix, hash, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
     returning *`,
    [
      input.name,
      input.ownerPrincipalId,
      input.createdByPrincipalId,
      input.organizationId,
      input.permissions,
      input.prefix,
      input.hash,
      input.expiresAt,
    ],
  );
  return rows[0]!;
}

export async function touchLiveTokenByHash(db: Queryable, hash: string): Promise<Row | undefined> {
  const { rows } = await db.query(
    `update api_token set last_used_at = now()
      where hash = $1 and revoked_at is null and (expires_at is null or expires_at > now())
      returning *`,
    [hash],
  );
  return rows[0];
}

export async function selectTokensByOwner(db: Queryable, ownerPrincipalId: string): Promise<Row[]> {
  const { rows } = await db.query(
    `select * from api_token where owner_principal_id = $1 order by created_at desc`,
    [ownerPrincipalId],
  );
  return rows;
}

export async function revokeOwnedToken(db: Queryable, ownerPrincipalId: string, tokenId: string): Promise<Row | undefined> {
  const { rows } = await db.query(
    `update api_token set revoked_at = coalesce(revoked_at, now())
      where id = $1 and owner_principal_id = $2
      returning *`,
    [tokenId, ownerPrincipalId],
  );
  return rows[0];
}
