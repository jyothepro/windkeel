import type { Pool, PoolClient } from "pg";
import { getRepository, type Repository } from "../repository-entity.js";
import { getEngineeringRun, getEngineeringTask } from "../repositories.js";
import type { RepositoryTarget } from "./stage-deps.js";

type Queryable = Pool | PoolClient;

const LOCAL_SOURCE_TYPES = new Set(["local", "cli"]);

export class MissingRepositoryError extends Error {
  constructor(
    readonly taskId: string,
    readonly repositoryId: string,
    readonly sourceType: string,
  ) {
    super(
      `task ${taskId} (source ${sourceType}) points at repository ${repositoryId}, which has no ` +
        `row. Refusing to fall back to the container's configured repository: a task that came ` +
        `from outside cannot be run against a repository chosen by configuration.`,
    );
    this.name = "MissingRepositoryError";
  }
}

export async function resolveRepositoryContext(
  db: Queryable,
  engineeringRunId: string,
  fallback: RepositoryTarget,
): Promise<{ target: RepositoryTarget; repository: Repository | null; organizationId: string }> {
  const run = await getEngineeringRun(db, engineeringRunId);
  if (!run) throw new Error(`no engineering_run ${engineeringRunId}`);
  const task = await getEngineeringTask(db, run.taskId);
  if (!task) throw new Error(`no engineering_task ${run.taskId}`);

  const repository = await getRepository(db, task.repositoryId);
  if (repository) {
    return {
      target: { url: repository.cloneUrl, baseRevision: repository.defaultBranch },
      repository,
      organizationId: task.organizationId,
    };
  }
  if (LOCAL_SOURCE_TYPES.has(task.sourceType)) {
    return { target: fallback, repository: null, organizationId: task.organizationId };
  }
  throw new MissingRepositoryError(task.id, task.repositoryId, task.sourceType);
}

export async function resolveRepositoryTarget(
  db: Queryable,
  engineeringRunId: string,
  fallback: RepositoryTarget,
): Promise<RepositoryTarget> {
  return (await resolveRepositoryContext(db, engineeringRunId, fallback)).target;
}
