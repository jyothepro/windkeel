import type { Pool } from "pg";
import { getEngineeringRun, getEngineeringTask } from "../repositories.js";
import type { EngineeringRun, EngineeringTask } from "../repositories.js";
import { getRepository, type Repository } from "../repository-entity.js";
import { recordAuditEvent, withTransaction, type AuditContext } from "../audit-log.js";
import {
  clearRepositoryIntake,
  deleteGrantRow,
  grantExists,
  lockRepositoryRow,
  runGrantExists,
  selectGrantFacts,
  selectGrants,
  taskGrantExists,
  upsertGrant,
} from "./stores/grant-store.js";
import { type Queryable, isUuid } from "./common.js";

export async function taskInOrganization(
  db: Queryable,
  organizationId: string,
  taskId: string,
): Promise<EngineeringTask | null> {
  if (!isUuid(taskId)) return null;
  const task = await getEngineeringTask(db, taskId);
  return task && task.organizationId === organizationId ? task : null;
}

export async function runInOrganization(
  db: Queryable,
  organizationId: string,
  runId: string,
): Promise<EngineeringRun | null> {
  if (!isUuid(runId)) return null;
  const run = await getEngineeringRun(db, runId);
  if (!run) return null;
  const task = await taskInOrganization(db, organizationId, run.taskId);
  return task ? run : null;
}

export async function grantedRepository(
  db: Queryable,
  organizationId: string,
  repositoryId: string,
): Promise<Repository | null> {
  if (!isUuid(repositoryId)) return null;
  return (await grantExists(db, organizationId, repositoryId)) ? getRepository(db, repositoryId) : null;
}

export async function organizationHoldsGrant(
  db: Queryable,
  organizationId: string,
  repositoryId: string,
): Promise<boolean> {
  if (!isUuid(repositoryId)) return false;
  return grantExists(db, organizationId, repositoryId);
}

export async function taskRepositoryGranted(db: Queryable, taskId: string): Promise<boolean> {
  if (!isUuid(taskId)) return false;
  return taskGrantExists(db, taskId);
}

export async function runRepositoryGranted(db: Queryable, runId: string): Promise<boolean> {
  if (!isUuid(runId)) return false;
  return runGrantExists(db, runId);
}

export interface RepositoryGrant {
  repositoryId: string;
  fullName: string;
  intake: boolean;
  createdAt: Date;
}

export async function listGrants(db: Queryable, organizationId: string): Promise<RepositoryGrant[]> {
  return (await selectGrants(db, organizationId)).map((row) => ({
    repositoryId: row["repository_id"] as string,
    fullName: `${row["owner"] as string}/${row["name"] as string}`,
    intake: row["intake"] as boolean,
    createdAt: row["created_at"] as Date,
  }));
}

export class GrantError extends Error {
  override readonly name = "GrantError";
}

export class GrantForbiddenError extends Error {
  override readonly name = "GrantForbiddenError";
}

export async function putGrant(
  pool: Pool,
  input: {
    organizationId: string;
    repositoryId: string;
    intake: boolean;
    createdByPrincipalId: string;

    audit?: AuditContext | undefined;
  },
): Promise<RepositoryGrant> {
  await withTransaction(pool, async (client) => {

    await lockRepositoryRow(client, input.repositoryId);
    const facts = await selectGrantFacts(client, input.organizationId, input.repositoryId, input.createdByPrincipalId);
    if (!facts.repoExists) throw new GrantError("no such repository");
    if (facts.repoAccount !== null && facts.repoAccount !== facts.orgAccount) {
      throw new GrantError("that repository belongs to another account");
    }
    if (facts.heldElsewhere && !facts.accountManages) {
      throw new GrantForbiddenError(
        "another organization holds this repository; granting it here needs repositories.manage through an account role",
      );
    }
    if (input.intake) await clearRepositoryIntake(client, input.repositoryId);
    await upsertGrant(client, input);
    if (input.audit) {
      await recordAuditEvent(client, {
        organizationId: input.organizationId,
        ...input.audit,
        action: "grant.created",
        target: { type: "repository", id: input.repositoryId },
        detail: { intake: input.intake },
      });
    }
  });
  const grants = await listGrants(pool, input.organizationId);
  return grants.find((g) => g.repositoryId === input.repositoryId)!;
}

export async function deleteGrant(db: Queryable, organizationId: string, repositoryId: string): Promise<boolean> {
  if (!isUuid(repositoryId)) return false;
  return deleteGrantRow(db, organizationId, repositoryId);
}
