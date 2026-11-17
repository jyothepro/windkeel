import type { Pool, PoolClient } from "pg";
import type { Criterion } from "@windkeel/verification/evidence/format.js";
import { type RiskLevel, runRails } from "./rails.js";
import type { TaskModelOverride } from "./model-policy.js";
import type { PlaybookSnapshot } from "./playbooks.js";
import {
  type EngineeringRun,
  type EngineeringTask,
  insertEngineeringRun,
  insertEngineeringTask,
  resolveTaskOrganizationId,
} from "./repositories.js";
import { selectTaskOrganizationColumn } from "./stores/task-store.js";

type Queryable = Pool | PoolClient;

export type RunAdmission = <R extends RailsOptions>(db: Queryable, organizationId: string, rails: R) => Promise<R>;

export interface RailsOptions {
  spendCapUsd?: number | null;
  wallClockCapSeconds?: number;
  uncappedConfirmed?: boolean;
}

export interface TaskSpec {

  organizationId?: string;
  repositoryId: string;

  sourceType: string;
  sourceReference: string;
  title: string;
  description: string;
  criteria: Criterion[];
  riskLevel: RiskLevel;
  rails?: RailsOptions;

  createdByPrincipalId?: string;

  modelOverride?: TaskModelOverride | null;

  playbook?: PlaybookSnapshot | null;
}

export async function createTaskAndRun(
  db: Queryable,
  spec: TaskSpec,
  admitRun: RunAdmission,
): Promise<{ task: EngineeringTask; run: EngineeringRun }> {

  const organizationId = await resolveTaskOrganizationId(db, spec.organizationId, spec.repositoryId);
  const rails = organizationId ? await admitRun(db, organizationId, spec.rails ?? {}) : (spec.rails ?? {});
  const task = await insertEngineeringTask(db, {
    ...(spec.organizationId ? { organizationId: spec.organizationId } : {}),
    ...(spec.createdByPrincipalId ? { createdByPrincipalId: spec.createdByPrincipalId } : {}),
    ...(spec.modelOverride ? { modelOverride: spec.modelOverride } : {}),
    ...(spec.playbook ? { playbook: spec.playbook } : {}),
    repositoryId: spec.repositoryId,
    sourceType: spec.sourceType,
    sourceReference: spec.sourceReference,
    title: spec.title,
    description: spec.description,
    acceptanceCriteria: spec.criteria,
    riskLevel: spec.riskLevel,
    priority: null,
    status: "OPEN",
  });
  const run = await insertRun(db, task.id, rails);
  return { task, run };
}

export async function startNewRun(
  db: Queryable,
  taskId: string,
  options: RailsOptions & {

    modelOverride?: TaskModelOverride | null;
  } = {},
  admitRun: RunAdmission,
): Promise<EngineeringRun> {

  const organizationId = await selectTaskOrganizationColumn(db, taskId);
  return insertRun(db, taskId, organizationId ? await admitRun(db, organizationId, options) : options);
}

async function insertRun(
  db: Queryable,
  taskId: string,
  options: RailsOptions & { modelOverride?: TaskModelOverride | null },
): Promise<EngineeringRun> {
  const rails = runRails({
    ...(options.spendCapUsd !== undefined ? { spendCapUsd: options.spendCapUsd } : {}),
    ...(options.wallClockCapSeconds !== undefined
      ? { wallClockCapSeconds: options.wallClockCapSeconds }
      : {}),
    ...(options.uncappedConfirmed !== undefined
      ? { uncappedConfirmed: options.uncappedConfirmed }
      : {}),
  });
  return insertEngineeringRun(db, {
    taskId,
    spendCapUsd: rails.spend_cap_usd,
    wallClockCapSeconds: rails.wall_clock_cap_seconds,
    ...(options.modelOverride ? { modelOverride: options.modelOverride } : {}),
  });
}
