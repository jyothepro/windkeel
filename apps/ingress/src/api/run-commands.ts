import { runInOrganization, runRepositoryGranted } from "@windkeel/factory/tenancy";
import { TERMINAL_STATES } from "@windkeel/factory/runs";
import { type ApiDeps, type ApiResult, type Scope, acted, auditAfter, badRequest, commandResult, conflict, notFound, repositoryNoLongerGranted, stringField } from "./common.js";

export async function approveRun(deps: ApiDeps, scope: Scope, runId: string): Promise<ApiResult> {
  const exists = await runInOrganization(deps.pool, scope.organizationId, runId);
  if (!exists) return notFound("run");

  if (!(await runRepositoryGranted(deps.pool, runId))) return repositoryNoLongerGranted();
  const result = await deps.control.approve(runId, scope.actor);
  if (acted(result)) await auditAfter(deps, scope, { action: "run.approved", target: { type: "run", id: runId } });
  return commandResult(deps, runId, result);
}

export async function cancelRun(
  deps: ApiDeps,
  scope: Scope,
  runId: string,
  body: unknown,
): Promise<ApiResult> {
  const exists = await runInOrganization(deps.pool, scope.organizationId, runId);
  if (!exists) return notFound("run");
  const reason = stringField(body, "reason") ?? `cancelled via API by ${scope.actor}`;
  const result = await deps.control.cancel(runId, reason, scope.actor);
  if (acted(result)) {
    await auditAfter(deps, scope, { action: "run.cancelled", target: { type: "run", id: runId }, detail: { reason: reason.slice(0, 500) } });
  }
  return commandResult(deps, runId, result);
}

export async function sendRunMessage(
  deps: ApiDeps,
  scope: Scope,
  runId: string,
  body: unknown,
): Promise<ApiResult> {
  const exists = await runInOrganization(deps.pool, scope.organizationId, runId);
  if (!exists) return notFound("run");

  if (!(await runRepositoryGranted(deps.pool, runId))) return repositoryNoLongerGranted();

  const message = stringField(body, "message");
  if (message === undefined || message.trim() === "") {
    return badRequest("message is required and may not be empty", "missing_message");
  }
  if (TERMINAL_STATES.has(exists.status)) {
    return conflict(`run is ${exists.status}; nothing is listening`, "run_terminal");
  }
  if (!MAKER_LISTENING.has(exists.status)) {
    return conflict(
      `run is ${exists.status}; a maker is only listening in ${[...MAKER_LISTENING].join(" or ")}`,
      "maker_not_listening",
    );
  }
  const result = await deps.control.message(runId, message, scope.actor, scope.principalId);
  return commandResult(deps, runId, result);
}

const MAKER_LISTENING: ReadonlySet<string> = new Set(["IMPLEMENTING", "REPAIRING", "VERIFYING"]);
