

import type { Pool, PoolClient } from "pg";

type Db = Pool | PoolClient;

export async function selectRunModelConfig(db: Db, engineeringRunId: string): Promise<unknown> {
  const { rows } = await db.query("select model_config from engineering_run where id = $1", [
    engineeringRunId,
  ]);
  return rows[0]?.["model_config"];
}

export async function runOrganizationId(db: Db, engineeringRunId: string): Promise<string | undefined> {
  const { rows } = await db.query(
    `select t.organization_id from engineering_run r join engineering_task t on t.id = r.task_id
      where r.id = $1`,
    [engineeringRunId],
  );
  return rows[0]?.["organization_id"] as string | undefined;
}

export async function repositoryExists(db: Db, repositoryId: string): Promise<boolean> {
  const known = await db.query("select 1 from repository where id = $1", [repositoryId]);
  return known.rows.length > 0;
}

export async function latestSnapshotStatus(
  db: Db,
  organizationId: string,
  repositoryId: string,
  sandboxProvider: string,
): Promise<{ status: unknown; recent: unknown } | undefined> {
  const { rows } = await db.query(
    `select status, created_at > now() - interval '1 hour' as recent from environment_snapshot
      where organization_id = $1 and repository_id = $2 and sandbox_provider = $3
      order by created_at desc limit 1`,
    [organizationId, repositoryId, sandboxProvider],
  );
  return rows[0];
}

export async function invalidateCredentialIfSealed(
  db: Db,
  credentialId: string,
  organizationId: string,
  sealed: string,
  reason: string,
): Promise<void> {
  await db.query(
    `update model_credential
          set status = 'invalid', status_reason = $4, validated_at = now(), updated_at = now()
        where id = $1 and organization_id = $2 and revoked_at is null and sealed_value = $3`,
    [credentialId, organizationId, sealed, reason],
  );
}

export async function invalidateCredential(
  db: Db,
  credentialId: string,
  organizationId: string,
  reason: string,
): Promise<void> {
  await db.query(
    `update model_credential
          set status = 'invalid', status_reason = $3, validated_at = now(), updated_at = now()
        where id = $1 and organization_id = $2 and revoked_at is null`,
    [credentialId, organizationId, reason],
  );
}
