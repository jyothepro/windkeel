import type { Pool, PoolClient } from "pg";
import {
  createTaskAndRun as createTaskAndRunWith,
  startNewRun as startNewRunWith,
  type RunAdmission,
  type TaskSpec,
} from "../factory/task-creation.js";
import type { EngineeringRun, EngineeringTask } from "../factory/repositories.js";
import { admitRun } from "./admission.js";

export type { RailsOptions, TaskSpec } from "../factory/task-creation.js";

type Queryable = Pool | PoolClient;

const billingAdmission: RunAdmission = (db, organizationId, rails) => admitRun(db, organizationId, rails);

export function createTaskAndRun(db: Queryable, spec: TaskSpec): Promise<{ task: EngineeringTask; run: EngineeringRun }> {
  return createTaskAndRunWith(db, spec, billingAdmission);
}

export function startNewRun(
  db: Queryable,
  taskId: string,
  options: Parameters<typeof startNewRunWith>[2] = {},
): Promise<EngineeringRun> {
  return startNewRunWith(db, taskId, options, billingAdmission);
}
