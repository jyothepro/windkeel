import { listRunsPage, listTasksPage } from "@windkeel/factory/runs";
import { taskInOrganization } from "@windkeel/factory/tenancy";
import { isConnectionLimit } from "../connection-limit.js";
import { type ApiDeps, type ApiResult, type Query, type Scope, notFound, numeric, ok } from "./common.js";
import { pingDatabase } from "../stores/health-store.js";

export async function health(deps: ApiDeps): Promise<ApiResult> {
  try {
    await pingDatabase(deps.pool);
  } catch (err) {

    if (isConnectionLimit(err)) return { status: 503, body: { ok: false, database: "connection_limit" } };
    return { status: 503, body: { ok: false, database: "unreachable" } };
  }
  if (!deps.schema) return ok({ ok: true, database: "reachable" });

  const schema = await deps.schema.status(deps.pool);
  switch (schema.state) {
    case "current":
      return ok({ ok: true, database: "reachable", schema: "current" });
    case "behind":
      return {
        status: 503,
        body: { ok: false, database: "reachable", schema: "behind", code: "schema_behind", pending: schema.pending },
      };

    case "unverifiable":
      return { status: 503, body: { ok: false, database: "reachable", schema: "unverifiable" } };
    case "unknown":
      return { status: 503, body: { ok: false, database: "reachable", schema: "unknown" } };
  }
}

export async function tasks(deps: ApiDeps, scope: Scope, query: Query): Promise<ApiResult> {
  const page = await listTasksPage(deps.pool, {
    organizationId: scope.organizationId,
    repositoryId: query.get("repository"),
    status: query.get("status"),
    sourceType: query.get("source"),
    cursor: query.get("cursor"),
    limit: numeric(query.get("limit")),
  });
  return ok(page);
}

export async function task(deps: ApiDeps, scope: Scope, taskId: string): Promise<ApiResult> {
  const row = await taskInOrganization(deps.pool, scope.organizationId, taskId);
  if (!row) return notFound("task");
  return ok({
    ...row,

    criteria: {
      provenance: row.criteriaProvenance,
      generatedBy: row.criteriaGeneratedBy,
      approvedBy: row.criteriaApprovedBy,
      approvedAt: row.criteriaApprovedAt,
      items: row.acceptanceCriteria,
    },
  });
}

export async function taskRuns(
  deps: ApiDeps,
  scope: Scope,
  taskId: string,
  query: Query,
): Promise<ApiResult> {
  const exists = await taskInOrganization(deps.pool, scope.organizationId, taskId);
  if (!exists) return notFound("task");
  const page = await listRunsPage(deps.pool, {
    organizationId: scope.organizationId,
    taskId,
    cursor: query.get("cursor"),
    limit: numeric(query.get("limit")),
  });
  return ok(page);
}
