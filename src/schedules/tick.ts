

import type { Pool, PoolClient } from "pg";
import { runIntake, type IntakeResponse, type IntakeSource, type RawRequest } from "../intake/pipeline.js";
import { defaultLog, describeError, type IntakeLog } from "../factory/log.js";
import { createTaskFromIntake } from "../intake/create-task.js";
import { getSystemActor } from "../factory/tenancy.js";
import { TERMINAL_STATES } from "../factory/run-state-machine.js";
import { withSweepLock, type LockOutcome } from "../factory/sweeps/advisory-lock.js";
import { latestFireTimeAtOrBefore, localDate, nextFireTime, parseCron } from "./cron.js";
import {
  claimNextDueSchedule,
  lockScheduleRow,
  recordSlotOutcome,
  rowToSchedule,
  selectOtherSlotLiveRuns,
  selectRepositoryGrant,
  type Schedule,
} from "./store.js";
import { withTransaction } from "../factory/db/transaction.js";

const SCHEDULES_SWEEP = "schedules";
const SCHEDULE_SOURCE = "schedule";
const SCHEDULE_SOURCE_TYPE = "schedule";

const SCHEDULE_ACTOR_PURPOSE = "schedules";

const MAX_COALESCED_RECORDS = 100;

export const MAX_COALESCED_PER_TICK = 500;

const MAX_SCHEDULES_PER_TICK = 200;

const TICK_BUDGET_MS = 40_000;

export const MAX_SLOT_ATTEMPTS = 5;

export const SLOT_ABANDONED_TAG = "schedule_slot_abandoned";

export interface ScheduleTickDeps {

  startRun(engineeringRunId: string): Promise<{ enqueued: boolean }>;

  log?: IntakeLog;

  clock?: () => number;

  budgetMs?: number;

  maxCoalescedPerTick?: number;
}

export type SlotOutcome =
  | { kind: "created" | "existing"; taskId: string; runId: string; enqueued: boolean }
  | { kind: "ignored"; reason: string }
  | { kind: "duplicate" }
  | { kind: "failed"; status: number; error: string };

export interface ScheduleFired {
  scheduleId: string;
  slot: string;
  outcome: SlotOutcome;
  coalesced: number;
  nextFireAt: string;
}

export type StoppedEarly = "time_budget" | "coalesced_budget" | "schedule_cap";

export interface TickResult {
  fired: ScheduleFired[];

  stoppedEarly: StoppedEarly | null;
}

export function slotKey(scheduleId: string, slot: Date | string): string {
  return `schedule:${scheduleId}:${typeof slot === "string" ? slot : slot.toISOString()}`;
}

function renderTemplate(template: string, schedule: Pick<Schedule, "name" | "timezone">, slot: Date): string {
  return template
    .replace(/\{\{\s*date\s*\}\}/g, localDate(slot, schedule.timezone))
    .replace(/\{\{\s*schedule\s*\}\}/g, schedule.name);
}

export async function fireDueSchedules(
  pool: Pool,
  now: Date,
  deps: ScheduleTickDeps,
): Promise<LockOutcome<TickResult>> {

  const logged = { ...deps, log: deps.log ?? defaultLog };
  return withSweepLock(pool, SCHEDULES_SWEEP, () => fireDueSchedulesUnlocked(pool, now, logged));
}

async function fireDueSchedulesUnlocked(pool: Pool, now: Date, deps: ScheduleTickDeps): Promise<TickResult> {
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const budgetMs = deps.budgetMs ?? TICK_BUDGET_MS;
  let coalescedLeft = deps.maxCoalescedPerTick ?? MAX_COALESCED_PER_TICK;
  const fired: ScheduleFired[] = [];
  const reached: string[] = [];
  let stoppedEarly: StoppedEarly | null = null;

  for (;;) {
    if (reached.length >= MAX_SCHEDULES_PER_TICK) {
      stoppedEarly = "schedule_cap";
      break;
    }
    if (clock() - started >= budgetMs) {
      stoppedEarly = "time_budget";
      break;
    }
    if (coalescedLeft <= 0) {
      stoppedEarly = "coalesced_budget";
      break;
    }
    const schedule = await claimNext(pool, now, reached);
    if (!schedule) break;
    reached.push(schedule.id);

    let result: ScheduleFired;
    try {
      result = await fireOne(pool, schedule, now, deps, Math.min(MAX_COALESCED_RECORDS, coalescedLeft));
    } catch (error) {

      deps.log?.("schedule tick failed", { scheduleId: schedule.id, ...describeError(error) });
      result = {
        scheduleId: schedule.id,
        slot: schedule.nextFireAt.toISOString(),
        outcome: { kind: "failed", status: 500, error: "internal error" },
        coalesced: 0,
        nextFireAt: nextSlotAfter(schedule, now).toISOString(),
      };
    }
    coalescedLeft -= result.coalesced;
    fired.push(await advance(pool, schedule, result, deps));
  }
  return { fired, stoppedEarly };
}

async function claimNext(pool: Pool, now: Date, reached: string[]): Promise<Schedule | null> {
  return withTransaction(pool, async (client) => {
    const { rows } = await claimNextDueSchedule(client, now, reached);
    return rows[0] ? rowToSchedule(rows[0]) : null;
  });
}

async function advance(pool: Pool, schedule: Schedule, result: ScheduleFired, deps: ScheduleTickDeps): Promise<ScheduleFired> {
  const failed = result.outcome.kind === "failed";
  const failures = failed ? schedule.consecutiveFailures + 1 : 0;
  const abandoned = failed && failures >= MAX_SLOT_ATTEMPTS;
  const moves = !failed || abandoned;
  if (abandoned) {
    deps.log?.("schedule slot abandoned after repeated failures", {
      tag: SLOT_ABANDONED_TAG,
      scheduleId: schedule.id,
      slot: result.slot,
      attempts: failures,
      status: result.outcome.kind === "failed" ? result.outcome.status : undefined,
    });
  }
  const created = result.outcome.kind === "created" || result.outcome.kind === "existing";
  await recordSlotOutcome(pool, {
    scheduleId: schedule.id,
    moves,
    claimedSlot: schedule.nextFireAt,
    nextFireAt: result.nextFireAt,
    created,
    slot: result.slot,
    outcome: describeOutcome(result.outcome),
    failures: abandoned ? 0 : failures,
  });
  return moves ? result : { ...result, nextFireAt: schedule.nextFireAt.toISOString() };
}

function describeOutcome(outcome: SlotOutcome): string {
  switch (outcome.kind) {
    case "created":
    case "existing":
    case "duplicate":
      return outcome.kind;
    case "ignored":
      return `ignored:${outcome.reason}`;
    case "failed":
      return `failed:${outcome.status}`;
  }
}

function nextSlotAfter(schedule: Schedule, now: Date): Date {
  const parked = new Date(now.getTime() + 366 * 86_400_000);
  try {
    return nextFireTime(schedule.cron, now, schedule.timezone) ?? parked;
  } catch {

    return parked;
  }
}

async function fireOne(
  pool: Pool,
  schedule: Schedule,
  now: Date,
  deps: ScheduleTickDeps,
  coalescedCap: number,
): Promise<ScheduleFired> {
  const expr = parseCron(schedule.cron);
  const latest = latestFireTimeAtOrBefore(expr, schedule.nextFireAt, now, schedule.timezone);

  let coalesced = 0;
  for (
    let slot: Date | null = schedule.nextFireAt;
    slot && slot.getTime() < latest.getTime() && coalesced < coalescedCap;
    slot = nextFireTime(expr, slot, schedule.timezone)
  ) {
    await runIntake(ignoredSlotSource(schedule, slot, "coalesced"), EMPTY_REQUEST, {
      pool,
      ...(deps.log ? { log: deps.log } : {}),
    });
    coalesced++;
  }

  const outcome = await fireSlot(pool, schedule, latest, slotKey(schedule.id, latest), deps);
  return {
    scheduleId: schedule.id,
    slot: latest.toISOString(),
    outcome,
    coalesced,
    nextFireAt: nextSlotAfter(schedule, now).toISOString(),
  };
}

const EMPTY_REQUEST: RawRequest = { headers: {}, rawBody: "" };

function inProcessSource<P>(payload: P, deliveryKey: string, interpret: IntakeSource<P>["interpret"]): IntakeSource<P> {
  return {
    name: SCHEDULE_SOURCE,

    verify: async () => ({ ok: true }),
    parse: () => payload,
    deliveryKey: () => deliveryKey,
    interpret,
  };
}

function ignoredSlotSource(schedule: Schedule, slot: Date, reason: string): IntakeSource<null> {
  return inProcessSource(null, slotKey(schedule.id, slot), async () => ({
    kind: "ignore",
    reason,
    event: "schedule",
    action: "tick",
    organizationId: schedule.organizationId,
  }));
}

interface ActResult {
  task: { taskId: string; runId: string; created: boolean } | null;
  enqueued: boolean;
}

export async function fireSlot(
  pool: Pool,
  schedule: Schedule,
  slot: Date,
  deliveryKey: string,
  deps: ScheduleTickDeps,
  action: "tick" | "manual" = "tick",
): Promise<SlotOutcome> {
  const acted: ActResult = { task: null, enqueued: false };

  const source = inProcessSource(null, deliveryKey, async () => ({
    kind: "act",
    intent: "create_task",
    event: "schedule",
    action,
    organizationId: schedule.organizationId,
    act: async (tx) => {

      const lockedRow = await lockScheduleRow(tx.db, schedule.id);
      if (lockedRow.rowCount === 0) {
        await tx.ignore("schedule_deleted");
        return;
      }
      const granted = await selectRepositoryGrant(tx.db, schedule.organizationId, schedule.repositoryId);
      if (granted.rowCount === 0) {
        await tx.ignore("repository_not_granted");
        return;
      }
      const previous = await previousRuns(tx.db, schedule, deliveryKey);
      if (previous.inFlight) {
        await tx.ignore("previous_run_in_flight");
        return;
      }
      if (previous.stranded.length > 0) {
        await tx.ignore("previous_run_requeued");
        return async () => {
          for (const runId of previous.stranded) await deps.startRun(runId);
        };
      }
      const actor = await getSystemActor(tx.db, schedule.organizationId, SCHEDULE_ACTOR_PURPOSE);
      const result = await createTaskFromIntake(
        tx.db,
        {
          organizationId: schedule.organizationId,
          repositoryId: schedule.repositoryId,
          sourceType: SCHEDULE_SOURCE_TYPE,
          sourceReference: deliveryKey,
          sourceContext: { scheduleId: schedule.id, slot: slot.toISOString() },
          title: renderTemplate(schedule.title, schedule, slot),
          description: renderTemplate(schedule.description, schedule, slot),
          riskLevel: schedule.riskLevel,
          createdByPrincipalId: actor.id,
          rails: {
            ...(schedule.spendCapUsd !== null ? { spendCapUsd: schedule.spendCapUsd } : {}),
            ...(schedule.wallClockCapSeconds !== null ? { wallClockCapSeconds: schedule.wallClockCapSeconds } : {}),
          },
        },
        { startRun: deps.startRun },
      );
      acted.task = { taskId: result.taskId, runId: result.runId, created: result.created };
      await tx.record({ engineeringTaskId: result.taskId });
      return async () => {
        ({ enqueued: acted.enqueued } = await result.afterCommit());
      };
    },
  }));

  const response: IntakeResponse = await runIntake(source, EMPTY_REQUEST, {
    pool,
    ...(deps.log ? { log: deps.log } : {}),
  });
  if (response.status >= 300) {
    return { kind: "failed", status: response.status, error: response.body.error ?? "intake failed" };
  }
  if (response.body.duplicate) return { kind: "duplicate" };
  if (response.body.intent === "ignore") return { kind: "ignored", reason: response.body.reason ?? "ignored" };
  if (!acted.task) return { kind: "ignored", reason: response.body.reason ?? "no task" };
  const { taskId, runId, created } = acted.task;
  return { kind: created ? "created" : "existing", taskId, runId, enqueued: acted.enqueued };
}

async function previousRuns(
  db: PoolClient,
  schedule: Schedule,
  deliveryKey: string,
): Promise<{ inFlight: boolean; stranded: string[] }> {
  const { rows } = await selectOtherSlotLiveRuns(db, {
    organizationId: schedule.organizationId,
    sourceType: SCHEDULE_SOURCE_TYPE,
    referencePrefix: `schedule:${schedule.id}:`,
    deliveryKey,
    terminal: [...TERMINAL_STATES],
  });
  const stranded = rows.filter((r) => r.status === "CREATED" && !r.bound).map((r) => r.id);
  return { inFlight: stranded.length < rows.length, stranded };
}
