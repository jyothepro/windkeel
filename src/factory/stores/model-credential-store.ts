

import type { Queryable } from "../db/transaction.js";

type Row = Record<string, unknown>;

const VIEW_COLUMNS = `id, organization_id, provider, base_url, declared_vendor, label, last4, keypair_id,
  status, status_reason, validated_at, created_by_principal_id, created_at, updated_at, revoked_at`;

export interface ModelCredentialInsert {
  id: string;
  organizationId: string;
  provider: string;
  baseUrl: string | null;
  declaredVendor: string | null;
  label: string;
  last4: string;
  sealed: string;
  keypairId: string;
  createdByPrincipalId: string | null;
}

export async function insertModelCredentialRow(db: Queryable, v: ModelCredentialInsert): Promise<Row> {
  const { rows } = await db.query(
    `insert into model_credential
       (id, organization_id, provider, base_url, declared_vendor, label, last4, sealed_value,
        keypair_id, created_by_principal_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning ${VIEW_COLUMNS}`,
    [v.id, v.organizationId, v.provider, v.baseUrl, v.declaredVendor, v.label, v.last4, v.sealed, v.keypairId, v.createdByPrincipalId],
  );
  return rows[0]!;
}

export async function updateModelCredentialValueRow(
  db: Queryable,
  v: { credentialId: string; organizationId: string; sealed: string; keypairId: string; last4: string },
): Promise<Row | undefined> {
  const { rows } = await db.query(
    `update model_credential
        set sealed_value = $3, keypair_id = $4, last4 = $5, status = 'unverified',
            status_reason = null, validated_at = null, updated_at = now()
      where id = $1 and organization_id = $2 and revoked_at is null
      returning ${VIEW_COLUMNS}`,
    [v.credentialId, v.organizationId, v.sealed, v.keypairId, v.last4],
  );
  return rows[0];
}

export async function selectModelCredentialRows(db: Queryable, organizationId: string, includeRevoked: boolean): Promise<Row[]> {
  const { rows } = await db.query(
    `select ${VIEW_COLUMNS} from model_credential
      where organization_id = $1 ${includeRevoked ? "" : "and revoked_at is null"}
      order by label asc, created_at asc`,
    [organizationId],
  );
  return rows;
}

export async function selectModelCredentialRow(db: Queryable, organizationId: string, credentialId: string): Promise<Row | undefined> {
  const { rows } = await db.query(
    `select ${VIEW_COLUMNS} from model_credential where id = $1 and organization_id = $2`,
    [credentialId, organizationId],
  );
  return rows[0];
}

export async function revokeModelCredentialRow(db: Queryable, organizationId: string, credentialId: string): Promise<Row | undefined> {
  const { rows } = await db.query(
    `update model_credential
        set status = 'revoked', status_reason = null, sealed_value = '',
            revoked_at = coalesce(revoked_at, now()), updated_at = now()
      where id = $1 and organization_id = $2
      returning ${VIEW_COLUMNS}`,
    [credentialId, organizationId],
  );
  return rows[0];
}

export async function selectSealedModelCredentialRow(db: Queryable, organizationId: string, credentialId: string): Promise<Row | undefined> {
  const { rows } = await db.query(
    `select ${VIEW_COLUMNS}, sealed_value from model_credential where id = $1 and organization_id = $2`,
    [credentialId, organizationId],
  );
  return rows[0] as Row | undefined;
}

export async function selectModelCredentialVersion(db: Queryable, organizationId: string, credentialId: string): Promise<string | null> {
  const { rows } = await db.query(
    "select updated_at::text as version from model_credential where id = $1 and organization_id = $2",
    [credentialId, organizationId],
  );
  return (rows[0]?.["version"] as string | undefined) ?? null;
}

export async function recordModelCredentialValidation(
  db: Queryable,
  v: { organizationId: string; credentialId: string; version: string; status: string; reason: string | null },
): Promise<void> {
  await db.query(
    `update model_credential
        set status = $3, status_reason = $4, validated_at = now(), updated_at = now()
      where id = $1 and organization_id = $2 and revoked_at is null and updated_at::text = $5`,
    [v.credentialId, v.organizationId, v.status, v.reason, v.version],
  );
}
