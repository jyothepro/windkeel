
import type { Criterion } from "@windkeel/verification/evidence/format.js";
import type { RiskLevel } from "../rails.js";
import type { TaskModelOverride } from "../model-policy.js";
import type { PlaybookSnapshot } from "../playbooks.js";
import type { Queryable } from "../db/transaction.js";

export type TaskStatus =
  | "OPEN"
  | "IN_PROGRESS"
  | "WAITING_FOR_HUMAN"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface EngineeringTask {
  id: string;
  repositoryId: string;
  sourceType: string;
  sourceReference: string;
  title: string;
  description: string;
  acceptanceCriteria: Criterion[];
  riskLevel: RiskLevel;
  priority: number | null;
  status: TaskStatus;

  criteriaProvenance: CriteriaProvenance;

  criteriaGeneratedBy: string | null;
  criteriaApprovedAt: Date | null;
  criteriaApprovedBy: string | null;

  organizationId: string;

  createdByPrincipalId: string | null;

  sourceContext: Record<string, unknown>;

  modelOverride: TaskModelOverride | null;

  playbook: PlaybookSnapshot | null;
  createdAt: Date;
  updatedAt: Date;
}

export type CriteriaProvenance = "extracted" | "generated";

export type NewEngineeringTask = Omit<
  EngineeringTask,
  | "id"
  | "createdAt"
  | "updatedAt"
  | "criteriaProvenance"
  | "criteriaGeneratedBy"
  | "criteriaApprovedAt"
  | "criteriaApprovedBy"
  | "organizationId"
  | "createdByPrincipalId"
  | "sourceContext"
  | "modelOverride"
  | "playbook"
> &
  Partial<
    Pick<EngineeringTask, "criteriaProvenance" | "organizationId" | "createdByPrincipalId" | "modelOverride" | "playbook">
  >;

function rowToTask(row: Record<string, unknown>): EngineeringTask {
  return {
    id: row.id as string,
    repositoryId: row.repository_id as string,
    sourceType: row.source_type as string,
    sourceReference: row.source_reference as string,
    title: row.title as string,
    description: row.description as string,
    acceptanceCriteria: row.acceptance_criteria as Criterion[],
    riskLevel: row.risk_level as RiskLevel,
    priority: row.priority as number | null,
    status: row.status as TaskStatus,
    criteriaProvenance: row.criteria_provenance as CriteriaProvenance,
    criteriaGeneratedBy: row.criteria_generated_by as string | null,
    criteriaApprovedAt: row.criteria_approved_at as Date | null,
    criteriaApprovedBy: row.criteria_approved_by as string | null,
    organizationId: row.organization_id as string,
    createdByPrincipalId: (row.created_by_principal_id as string | null | undefined) ?? null,
    sourceContext: (row.source_context as Record<string, unknown> | null | undefined) ?? {},
    modelOverride: (row.model_override as TaskModelOverride | null | undefined) ?? null,
    playbook: (row.playbook as PlaybookSnapshot | null | undefined) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

export async function insertEngineeringTask(
  db: Queryable,
  task: NewEngineeringTask,
): Promise<EngineeringTask> {

  const playbook = task.playbook ? JSON.stringify(task.playbook) : null;
  const { rows } = await db.query(
    `insert into engineering_task
       (repository_id, source_type, source_reference, title, description,
        acceptance_criteria, risk_level, priority, status, criteria_provenance, organization_id,
        created_by_principal_id, model_override${playbook ? ", playbook" : ""})
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${TASK_ORGANIZATION}, $12, $13::jsonb${playbook ? ", $14::jsonb" : ""})
     returning *`,
    [
      task.repositoryId,
      task.sourceType,
      task.sourceReference,
      task.title,
      task.description,
      JSON.stringify(task.acceptanceCriteria),
      task.riskLevel,
      task.priority,
      task.status,
      task.criteriaProvenance ?? "extracted",
      task.organizationId ?? null,
      task.createdByPrincipalId ?? null,
      task.modelOverride ? JSON.stringify(task.modelOverride) : null,
      ...(playbook ? [playbook] : []),
    ],
  );
  return rowToTask(rows[0]);
}

const TASK_ORGANIZATION = `coalesce(
  $11::uuid,
  (select organization_id from repository_grant where repository_id = $1 and intake),
  (select o.id from organization o
    where o.is_default
      and (exists (select 1 from repository_grant g where g.repository_id = $1 and g.organization_id = o.id)
           or not exists (select 1 from repository_grant g where g.repository_id = $1)))
)`;

export async function resolveTaskOrganizationId(
  db: Queryable,
  organizationId: string | undefined,
  repositoryId: string,
): Promise<string | null> {
  const { rows } = await db.query(`select ${TASK_ORGANIZATION.replace("$11", "$2")} as id`, [
    repositoryId,
    organizationId ?? null,
  ]);
  return (rows[0]?.["id"] as string | null | undefined) ?? null;
}

export async function getEngineeringTask(db: Queryable, id: string): Promise<EngineeringTask | null> {
  const { rows } = await db.query("select * from engineering_task where id = $1", [id]);
  return rows[0] ? rowToTask(rows[0]) : null;
}

export async function getEngineeringTaskBySource(
  db: Queryable,
  repositoryId: string,
  sourceType: string,
  sourceReference: string,
): Promise<EngineeringTask | null> {
  const { rows } = await db.query(
    `select * from engineering_task
      where repository_id = $1 and source_type = $2 and source_reference = $3`,
    [repositoryId, sourceType, sourceReference],
  );
  return rows[0] ? rowToTask(rows[0]) : null;
}

export interface EngineeringTaskPatch {
  title?: string;
  description?: string;
  acceptanceCriteria?: Criterion[];
  status?: TaskStatus;
  riskLevel?: RiskLevel;
  criteriaProvenance?: CriteriaProvenance;
  criteriaGeneratedBy?: string | null;
  criteriaApprovedAt?: Date | null;
  criteriaApprovedBy?: string | null;
}

const TASK_PATCH_COLUMNS: Record<keyof EngineeringTaskPatch, string> = {
  title: "title",
  description: "description",
  acceptanceCriteria: "acceptance_criteria",
  status: "status",
  riskLevel: "risk_level",
  criteriaProvenance: "criteria_provenance",
  criteriaGeneratedBy: "criteria_generated_by",
  criteriaApprovedAt: "criteria_approved_at",
  criteriaApprovedBy: "criteria_approved_by",
};

export async function updateEngineeringTask(
  db: Queryable,
  id: string,
  patch: EngineeringTaskPatch,
): Promise<EngineeringTask> {
  const entries = Object.entries(patch) as Array<[keyof EngineeringTaskPatch, unknown]>;
  if (entries.length === 0) {
    const current = await getEngineeringTask(db, id);
    if (!current) throw new Error(`engineering_task ${id} not found`);
    return current;
  }
  const setClauses = entries.map(([key], i) => `${TASK_PATCH_COLUMNS[key]} = $${i + 2}`);
  const values = entries.map(([key, value]) =>
    key === "acceptanceCriteria" ? JSON.stringify(value) : value,
  );
  const { rows } = await db.query(
    `update engineering_task set ${setClauses.join(", ")}, updated_at = now()
      where id = $1 returning *`,
    [id, ...values],
  );
  if (!rows[0]) throw new Error(`engineering_task ${id} not found`);
  return rowToTask(rows[0]);
}

export async function selectTaskOrganizationColumn(db: Queryable, taskId: string): Promise<string | undefined> {
  const { rows } = await db.query("select organization_id from engineering_task where id = $1", [taskId]);
  return rows[0]?.["organization_id"] as string | undefined;
}
