
import type { Queryable } from "../db/transaction.js";

type Row = Record<string, unknown>;

const POLICY_COLUMNS = `id, organization_id, repository_id, role, provider, model, credential_id,
  declared_vendor, harness, created_at, updated_at, updated_by_principal_id`;

export async function selectModelPolicyRows(db: Queryable, organizationId: string, repositoryId: string | null | undefined): Promise<Row[]> {
  const params: unknown[] = [organizationId];
  let where = "organization_id = $1";
  if (repositoryId === null) {
    where += " and repository_id is null";
  } else if (repositoryId !== undefined) {
    params.push(repositoryId);
    where += " and (repository_id is null or repository_id = $2)";
  }
  const { rows } = await db.query(
    `select ${POLICY_COLUMNS} from model_policy where ${where}
      order by repository_id nulls first, role asc`,
    params,
  );
  return rows;
}

export interface ModelPolicyUpsert {
  organizationId: string;
  repositoryId: string | null;
  role: string;
  provider: string;
  model: string;
  credentialId: string | null;
  declaredVendor: string | null;
  updatedByPrincipalId: string | null;
  harness: string | null;
}

export async function upsertModelPolicyRow(db: Queryable, v: ModelPolicyUpsert): Promise<Row> {
  const { rows } = await db.query(
    `insert into model_policy
       (organization_id, repository_id, role, provider, model, credential_id, declared_vendor,
        updated_by_principal_id, harness)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (organization_id, coalesce(repository_id, '00000000-0000-0000-0000-000000000000'::uuid), role)
     do update set provider = excluded.provider, model = excluded.model,
                   credential_id = excluded.credential_id, declared_vendor = excluded.declared_vendor,
                   harness = excluded.harness,
                   updated_by_principal_id = excluded.updated_by_principal_id, updated_at = now()
     returning ${POLICY_COLUMNS}`,
    [v.organizationId, v.repositoryId, v.role, v.provider, v.model, v.credentialId, v.declaredVendor, v.updatedByPrincipalId, v.harness],
  );
  return rows[0]!;
}

export async function deleteModelPolicyRows(db: Queryable, organizationId: string, repositoryId: string | null, role: string | undefined): Promise<number> {
  const params: unknown[] = [organizationId];
  let where = "organization_id = $1";
  if (repositoryId === null) {
    where += " and repository_id is null";
  } else {
    params.push(repositoryId);
    where += ` and repository_id = $${params.length}`;
  }
  if (role) {
    params.push(role);
    where += ` and role = $${params.length}`;
  }
  const result = await db.query(`delete from model_policy where ${where}`, params);
  return result.rowCount ?? 0;
}

const PRESET_COLUMNS = `id, organization_id, name, harness, maker, checker, created_by_principal_id, created_at, updated_at`;

export async function selectModelPresetRows(db: Queryable, organizationId: string): Promise<Row[]> {
  const { rows } = await db.query(
    `select ${PRESET_COLUMNS} from model_preset where organization_id = $1 order by lower(name) asc`,
    [organizationId],
  );
  return rows;
}

export async function selectModelPresetRow(db: Queryable, organizationId: string, presetId: string): Promise<Row | undefined> {
  const { rows } = await db.query(`select ${PRESET_COLUMNS} from model_preset where organization_id = $1 and id = $2`, [
    organizationId,
    presetId,
  ]);
  return rows[0];
}

export interface ModelPresetValues {
  name: string;
  harness: string | null;

  maker: string;

  checker: string;
}

export async function insertModelPresetRow(db: Queryable, organizationId: string, v: ModelPresetValues, createdByPrincipalId: string | null): Promise<Row> {
  const { rows } = await db.query(
    `insert into model_preset (organization_id, name, harness, maker, checker, created_by_principal_id)
       values ($1, $2, $3, $4, $5, $6) returning ${PRESET_COLUMNS}`,
    [organizationId, v.name, v.harness, v.maker, v.checker, createdByPrincipalId],
  );
  return rows[0]!;
}

export async function updateModelPresetRow(db: Queryable, organizationId: string, presetId: string, v: ModelPresetValues): Promise<Row | undefined> {
  const { rows } = await db.query(
    `update model_preset set name = $3, harness = $4, maker = $5, checker = $6, updated_at = now()
      where organization_id = $1 and id = $2 returning ${PRESET_COLUMNS}`,
    [organizationId, presetId, v.name, v.harness, v.maker, v.checker],
  );
  return rows[0];
}

export async function deleteModelPresetRow(db: Queryable, organizationId: string, presetId: string): Promise<number> {
  const result = await db.query("delete from model_preset where organization_id = $1 and id = $2", [organizationId, presetId]);
  return result.rowCount ?? 0;
}
