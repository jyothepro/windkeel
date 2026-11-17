
import type { Queryable } from "../db/transaction.js";

type Row = Record<string, unknown>;

const COLUMNS = `id, organization_id, slug, name, kind, version, maker_instructions, criteria, verifier,
  default_risk_level, model_preset_id, archived_at, created_by_principal_id, created_at, updated_at`;

export async function selectLivePlaybookRows(db: Queryable, organizationId: string): Promise<Row[]> {
  const { rows } = await db.query(
    `select ${COLUMNS} from playbook where organization_id = $1 and archived_at is null order by slug asc`,
    [organizationId],
  );
  return rows;
}

export async function selectLivePlaybookRowById(db: Queryable, organizationId: string, id: string): Promise<Row | undefined> {
  const { rows } = await db.query(
    `select ${COLUMNS} from playbook where organization_id = $1 and id = $2 and archived_at is null`,
    [organizationId, id],
  );
  return rows[0];
}

export async function selectLivePlaybookRowBySlug(db: Queryable, organizationId: string, slug: string): Promise<Row | undefined> {
  const { rows } = await db.query(
    `select ${COLUMNS} from playbook where organization_id = $1 and slug = $2 and archived_at is null`,
    [organizationId, slug],
  );
  return rows[0];
}

export interface PlaybookValues {
  slug: string;
  name: string;
  kind: string;
  makerInstructions: string | null;

  criteria: string;

  verifier: string;
  defaultRiskLevel: string | null;
  modelPresetId: string | null;
}

export async function insertPlaybookRow(db: Queryable, organizationId: string, v: PlaybookValues, createdByPrincipalId: string | null): Promise<Row> {
  const { rows } = await db.query(
    `insert into playbook (organization_id, slug, name, kind, maker_instructions, criteria, verifier,
                           default_risk_level, model_preset_id, created_by_principal_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning ${COLUMNS}`,
    [
      organizationId,
      v.slug,
      v.name,
      v.kind,
      v.makerInstructions,
      v.criteria,
      v.verifier,
      v.defaultRiskLevel,
      v.modelPresetId,
      createdByPrincipalId,
    ],
  );
  return rows[0]!;
}

export async function updatePlaybookRow(db: Queryable, organizationId: string, id: string | null, v: PlaybookValues): Promise<Row | undefined> {
  const { rows } = await db.query(
    `update playbook
        set slug = $3, name = $4, kind = $5, maker_instructions = $6, criteria = $7, verifier = $8,
            default_risk_level = $9, model_preset_id = $10, version = version + 1, updated_at = now()
      where organization_id = $1 and id = $2 and archived_at is null
      returning ${COLUMNS}`,
    [
      organizationId,
      id,
      v.slug,
      v.name,
      v.kind,
      v.makerInstructions,
      v.criteria,
      v.verifier,
      v.defaultRiskLevel,
      v.modelPresetId,
    ],
  );
  return rows[0];
}

export async function archivePlaybookRow(db: Queryable, organizationId: string, id: string | null): Promise<void> {
  await db.query(
    "update playbook set archived_at = now(), updated_at = now() where organization_id = $1 and id = $2 and archived_at is null",
    [organizationId, id],
  );
}
