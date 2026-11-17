import { clampLimit, listQueue, listRepositoriesPage } from "@windkeel/factory/runs";
import type { Page } from "@windkeel/api-contract";
import { countOrganizations, hasAccountRole } from "@windkeel/factory/tenancy";
import type { Caller } from "./router.js";
import { sandboxProviders } from "./capture.js";
import { type ApiDeps, type ApiError, type ApiResult, type Query, type Scope, conflict, numeric, ok } from "./common.js";

export async function queue(deps: ApiDeps, scope: Scope, query: Query): Promise<ApiResult> {
  const items = await listQueue(deps.pool, scope.organizationId, clampLimit(numeric(query.get("limit"))));
  return ok({ items, endCursor: null, hasNextPage: false } satisfies Page<unknown>);
}

export async function repositories(deps: ApiDeps, scope: Scope, query: Query): Promise<ApiResult> {
  return ok(
    await listRepositoriesPage(
      deps.pool,
      scope.organizationId,
      query.get("cursor"),
      numeric(query.get("limit")),
    ),
  );
}

export async function metrics(deps: ApiDeps, caller: Caller): Promise<ApiResult> {
  const refused = await accountWide(deps, caller, "metrics cover");
  if (refused) return refused;
  const { collectMetrics } = await import("@windkeel/factory/runs");

  return ok(await collectMetrics(deps.pool));
}

async function accountWide(deps: ApiDeps, caller: Caller, what: string): Promise<ApiResult | null> {
  const [hasRole, organizationCount] = await Promise.all([
    hasAccountRole(deps.pool, caller.principal.id),
    countOrganizations(deps.pool, caller.principal.accountId),
  ]);
  if (hasRole || organizationCount <= 1) return null;
  return {
    status: 403,
    body: {
      error: `${what} the whole account, which has more than one organization; they need an account role`,
      code: "forbidden",
    } satisfies ApiError,
  };
}

export async function reapable(deps: ApiDeps, caller: Caller): Promise<ApiResult> {
  const refused = await accountWide(deps, caller, "sandboxes span");
  if (refused) return refused;
  const { listReapableWorkspaces } = await import("@windkeel/factory/ops");
  const items = await listReapableWorkspaces(deps.pool, new Date());
  return ok({ items, endCursor: null, hasNextPage: false } satisfies Page<unknown>);
}

export async function reap(deps: ApiDeps, caller: Caller): Promise<ApiResult> {
  const refused = await accountWide(deps, caller, "sandboxes span");
  if (refused) return refused;
  const reached = await sandboxProviders(deps);
  if ("refused" in reached) return reached.refused;
  const { providers } = reached;
  const { reapSandboxesLocked } = await import("@windkeel/factory/ops");
  const outcome = await reapSandboxesLocked({ pool: deps.pool, providers });
  if (outcome.kind === "contended") return conflict(outcome.reason, "sweep_in_progress");
  return ok(outcome.result);
}
