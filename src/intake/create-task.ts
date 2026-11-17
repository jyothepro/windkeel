

import type { Pool, PoolClient } from "pg";
import type { Criterion } from "@windkeel/verification/evidence/format.js";
import { extractCriteria } from "@windkeel/verification/stages/intent.js";
import type { RiskLevel } from "../factory/rails.js";
import { listEngineeringRuns } from "../factory/repositories.js";
import { createTaskAndRun, type RailsOptions } from "../billing/admitted-runs.js";
import { organizationHoldsGrant, taskRepositoryGranted } from "../factory/tenancy.js";
import type { TaskModelOverride } from "../factory/model-policy.js";
import type { PlaybookSnapshot } from "../factory/playbooks.js";
import { retriggerDecision } from "./relabel.js";
import { selectTaskBySourceReference, setTaskSourceContext } from "./stores/intake-store.js";
import { withTransaction } from "../factory/db/transaction.js";

type Queryable = Pool | PoolClient;

export interface IntakeTaskInput {

  organizationId?: string;
  repositoryId: string;

  sourceType: string;
  sourceReference: string;

  sourceContext?: Record<string, unknown>;
  title: string;
  description: string;
  riskLevel?: RiskLevel;

  createdByPrincipalId?: string | null;
  rails?: RailsOptions;

  criteriaSource?: Criterion["source"];

  modelOverride?: TaskModelOverride | null;

  playbook?: PlaybookSnapshot | null;
}

export interface IntakeTaskDeps {

  startRun(engineeringRunId: string): Promise<{ enqueued: boolean }>;
}

export interface IntakeTaskResult {
  taskId: string;
  runId: string;

  created: boolean;
  criteria: Criterion[];

  afterCommit(): Promise<{ enqueued: boolean }>;
}

export class RepositoryNotGrantedError extends Error {
  override readonly name = "RepositoryNotGrantedError";
  constructor(organizationId: string, repositoryId: string) {
    super(`organization ${organizationId} holds no grant on repository ${repositoryId}`);
  }
}

const UNKEYED_SOURCES = new Set(["github_issue", "local"]);

export async function createTaskFromIntake(
  db: Queryable,
  input: IntakeTaskInput,
  deps: IntakeTaskDeps,
): Promise<IntakeTaskResult> {

  if (isPool(db)) return withTransaction(db, (client) => createInTransaction(client, input, deps));
  return createInTransaction(db, input, deps);
}

async function createInTransaction(
  db: PoolClient,
  input: IntakeTaskInput,
  deps: IntakeTaskDeps,
): Promise<IntakeTaskResult> {
  const criteria = extractCriteria(
    input.description,
    input.criteriaSource ?? { kind: "explicit", ref: input.sourceReference },
  );
  const keyed = input.organizationId !== undefined && !UNKEYED_SOURCES.has(input.sourceType);

  if (keyed) {
    const existing = await findExisting(db, input, deps);
    if (existing) return existing;
  }

  if (input.organizationId !== undefined && !(await organizationHoldsGrant(db, input.organizationId, input.repositoryId))) {
    throw new RepositoryNotGrantedError(input.organizationId, input.repositoryId);
  }

  const spec = {
    ...(input.organizationId !== undefined ? { organizationId: input.organizationId } : {}),
    repositoryId: input.repositoryId,
    sourceType: input.sourceType,
    sourceReference: input.sourceReference,
    title: input.title,
    description: input.description,
    criteria,
    riskLevel: input.riskLevel ?? "low",
    ...(input.rails ? { rails: input.rails } : {}),
    ...(input.createdByPrincipalId ? { createdByPrincipalId: input.createdByPrincipalId } : {}),
    ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
    ...(input.playbook ? { playbook: input.playbook } : {}),
  };
  let created;
  if (keyed) {
    try {
      created = await withTransaction(db, (savepoint) => createTaskAndRun(savepoint, spec));
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        const winner = await findExisting(db, input, deps);
        if (winner) return winner;
      }
      throw error;
    }
  } else {
    created = await createTaskAndRun(db, spec);
  }

  if (input.sourceContext !== undefined) {
    await setTaskSourceContext(db, created.task.id, JSON.stringify(input.sourceContext));
  }

  const runId = created.run.id;
  return {
    taskId: created.task.id,
    runId,
    created: true,
    criteria,
    afterCommit: () => deps.startRun(runId),
  };
}

async function findExisting(
  db: PoolClient,
  input: IntakeTaskInput,
  deps: IntakeTaskDeps,
): Promise<IntakeTaskResult | null> {
  const { rows } = await selectTaskBySourceReference(db, input.organizationId, input.sourceType, input.sourceReference);
  const task = rows[0];
  if (!task) return null;
  const runs = await listEngineeringRuns(db, task.id);

  const decision = retriggerDecision(runs);
  const newest = decision.kind === "rerun" ? runs[0] : decision.run;
  if (!newest) throw new Error(`engineering_task ${task.id} has no run`);

  const reEnqueue = decision.kind === "re-enqueue" && (await taskRepositoryGranted(db, task.id));
  return {
    taskId: task.id,
    runId: newest.id,
    created: false,
    criteria: task.acceptance_criteria,
    afterCommit: reEnqueue ? () => deps.startRun(newest.id) : async () => ({ enqueued: false }),
  };
}

function isPool(db: Queryable): db is Pool {
  return typeof (db as PoolClient).release !== "function";
}
