
import type { Queryable } from "../db/transaction.js";

type Row = Record<string, unknown>;

export interface RepositorySecretUpsert {
  organizationId: string;
  repositoryId: string;
  key: string;
  sealedValue: string;
  note: string | null;
  setBy: string;
  setByPrincipalId: string | null;
}

export async function upsertRepositorySecretRow(db: Queryable, v: RepositorySecretUpsert): Promise<Row> {
  const { rows } = await db.query(
    `insert into repository_secret
       (organization_id, repository_id, key, sealed_value, note, set_by, set_by_principal_id)
       values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (organization_id, repository_id, key) do update
       set sealed_value        = excluded.sealed_value,
           note                = excluded.note,
           set_by              = excluded.set_by,
           set_by_principal_id = excluded.set_by_principal_id,
           updated_at          = now()
     returning key, note, set_by, created_at, updated_at`,
    [v.organizationId, v.repositoryId, v.key, v.sealedValue, v.note, v.setBy, v.setByPrincipalId],
  );
  return rows[0]!;
}

export async function selectRepositorySecretRows(db: Queryable, organizationId: string, repositoryId: string): Promise<Row[]> {
  const { rows } = await db.query(
    `select key, note, set_by, created_at, updated_at from repository_secret
       where organization_id = $1 and repository_id = $2 order by key asc`,
    [organizationId, repositoryId],
  );
  return rows;
}

export async function deleteRepositorySecretRow(db: Queryable, organizationId: string, repositoryId: string, key: string): Promise<number> {
  const { rowCount } = await db.query(
    `delete from repository_secret where organization_id = $1 and repository_id = $2 and key = $3`,
    [organizationId, repositoryId, key],
  );
  return rowCount ?? 0;
}

export async function selectSealedRepositorySecretRows(db: Queryable, organizationId: string, repositoryId: string): Promise<Row[]> {
  const { rows } = await db.query(
    `select key, sealed_value from repository_secret
      where organization_id = $1 and repository_id = $2 order by key asc`,
    [organizationId, repositoryId],
  );
  return rows;
}
