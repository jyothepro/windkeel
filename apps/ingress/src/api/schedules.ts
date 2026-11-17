import {
  CronError,
  nextFireTimes,
  parseCron,
  assertTimeZone,
} from "@windkeel/factory/schedules";
import {
  createSchedule as storeCreate,
  cronRefusal,
  deleteSchedule as storeDelete,
  getSchedule,
  listSchedules,
  ScheduleError,
  updateSchedule as storeUpdate,
  type Schedule,
} from "@windkeel/factory/schedules";
import { fireSlot, slotKey } from "@windkeel/factory/schedules";
import { accepted, auditAfter, audited, conflict, notFound, ok, type ApiDeps, type ApiResult, type Query, type Scope } from "./handlers.js";

function scheduleAudit(s: Schedule): Record<string, unknown> {
  return { name: s.name, cron: s.cron, timezone: s.timezone, repositoryId: s.repositoryId, enabled: s.enabled };
}

const VIEW_FIRE_TIMES = 3;

function scheduleView(s: Schedule, now = new Date()) {
  return {
    id: s.id,
    name: s.name,
    repositoryId: s.repositoryId,
    cron: s.cron,
    timezone: s.timezone,
    title: s.title,
    description: s.description,
    riskLevel: s.riskLevel,
    spendCapUsd: s.spendCapUsd,
    wallClockCapSeconds: s.wallClockCapSeconds,
    enabled: s.enabled,
    nextFireAt: s.nextFireAt.toISOString(),
    nextFireTimes: s.enabled
      ? [s.nextFireAt, ...nextFireTimes(s.cron, maxDate(s.nextFireAt, now), s.timezone, VIEW_FIRE_TIMES)]
          .filter((d, i, all) => all.findIndex((x) => x.getTime() === d.getTime()) === i)
          .slice(0, VIEW_FIRE_TIMES)
          .map((d) => d.toISOString())
      : [],
    lastFiredAt: s.lastFiredAt?.toISOString() ?? null,
    lastOutcome: s.lastOutcome,
    createdByPrincipalId: s.createdByPrincipalId,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

function refusal(error: unknown): ApiResult {
  if (error instanceof ScheduleError) {
    return { status: error.status, body: { error: error.message, code: error.code } };
  }
  throw error;
}

export async function schedules(deps: ApiDeps, scope: Scope, query: Query): Promise<ApiResult> {
  const rawLimit = query.get("limit");
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  const page = await listSchedules(deps.pool, scope.organizationId, {
    cursor: query.get("cursor"),
    limit: limit !== undefined && Number.isInteger(limit) ? limit : undefined,
  });
  const now = new Date();
  return ok({ ...page, items: page.items.map((s) => scheduleView(s, now)) });
}

export async function schedule(deps: ApiDeps, scope: Scope, scheduleId: string): Promise<ApiResult> {
  const found = await getSchedule(deps.pool, scope.organizationId, scheduleId);
  return found ? ok({ schedule: scheduleView(found) }) : notFound("schedule");
}

export async function createSchedule(deps: ApiDeps, scope: Scope, body: unknown): Promise<ApiResult> {
  try {
    const created = await audited(
      deps,
      scope,
      (tx) => storeCreate(tx, scope.organizationId, asInput(body), scope.principalId),
      (done) => ({ action: "schedule.created", target: { type: "schedule", id: done.id }, detail: scheduleAudit(done) }),
    );
    return { status: 201, body: { schedule: scheduleView(created) } };
  } catch (error) {
    return refusal(error);
  }
}

export async function updateSchedule(deps: ApiDeps, scope: Scope, scheduleId: string, body: unknown): Promise<ApiResult> {
  try {
    const updated = await storeUpdate(deps.pool, scope.organizationId, scheduleId, asInput(body));
    if (updated) await auditAfter(deps, scope, { action: "schedule.updated", target: { type: "schedule", id: updated.id }, detail: scheduleAudit(updated) });
    return updated ? ok({ schedule: scheduleView(updated) }) : notFound("schedule");
  } catch (error) {
    return refusal(error);
  }
}

export async function deleteSchedule(deps: ApiDeps, scope: Scope, scheduleId: string): Promise<ApiResult> {
  const removed = await audited(
    deps,
    scope,
    (tx) => storeDelete(tx, scope.organizationId, scheduleId),
    (done) => (done ? { action: "schedule.deleted", target: { type: "schedule", id: scheduleId } } : null),
  );
  return removed ? ok({ deleted: scheduleId }) : notFound("schedule");
}

export async function fireSchedule(deps: ApiDeps, scope: Scope, scheduleId: string): Promise<ApiResult> {
  const found = await getSchedule(deps.pool, scope.organizationId, scheduleId);
  if (!found) return notFound("schedule");
  const now = new Date();
  const key = slotKey(found.id, `manual:${now.toISOString()}`);
  const outcome = await fireSlot(
    deps.pool,
    found,
    now,
    key,
    { startRun: (runId) => deps.control.enqueue(runId) },
    "manual",
  );
  switch (outcome.kind) {
    case "created":
    case "existing":
      if (outcome.kind === "created") {
        await auditAfter(deps, scope, {
          action: "schedule.fired",
          target: { type: "schedule", id: found.id },
          detail: { taskId: outcome.taskId, runId: outcome.runId, manual: true },
        });
      }
      return accepted({ taskId: outcome.taskId, engineeringRunId: outcome.runId, enqueued: outcome.enqueued });
    case "ignored":
      if (outcome.reason === "previous_run_in_flight") {
        return conflict("this schedule's previous run is still in flight", "run_in_flight");
      }
      if (outcome.reason === "previous_run_requeued") {
        return conflict("this schedule's previous run had not started; it was enqueued again", "run_requeued");
      }
      return { status: 422, body: { error: `not fired: ${outcome.reason}`, code: outcome.reason } };
    case "duplicate":
      return conflict("this schedule was already fired at this instant", "duplicate");
    case "failed":
      return {
        status: 503,
        body: {
          error: "the schedule could not be fired; nothing was left half-done, so retrying is safe",
          code: "fire_failed",
        },
      };
  }
}

export async function previewSchedule(query: Query): Promise<ApiResult> {
  const cron = query.get("cron");
  const timezone = query.get("timezone") ?? "UTC";
  const count = Math.min(Math.max(Number(query.get("count") ?? 5) || 5, 1), 50);
  if (!cron) return { status: 400, body: { error: "cron is required", code: "missing_field" } };
  try {
    const expr = parseCron(cron);
    assertTimeZone(timezone);
    const times = nextFireTimes(expr, new Date(), timezone, count).map((d) => d.toISOString());
    if (times.length === 0) {
      return { status: 422, body: { error: `"${cron}" never fires (no date matches it)`, code: "invalid_cron" } };
    }
    return ok({ cron, timezone, nextFireTimes: times });
  } catch (error) {
    if (error instanceof CronError) return refusal(cronRefusal(error));
    throw error;
  }
}

function asInput(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}
