

import type { Pool, PoolClient, QueryResult } from "pg";
import { withTransaction } from "../factory/db/transaction.js";
import type { RiskLevel } from "../factory/rails.js";
import { isUuid } from "../factory/tenancy.js";
import { clampLimit, decodeCursor, paginate, type Page } from "../factory/api-queries.js";
import { CronError, validateSchedule } from "./cron.js";

type Queryable = Pool | PoolClient;

export interface Schedule {
  id: string;
  organizationId: string;
  repositoryId: string;
  name: string;
  cron: string;
  timezone: string;
  title: string;
  description: string;
  riskLevel: RiskLevel;
  spendCapUsd: number | null;
  wallClockCapSeconds: number | null;
  enabled: boolean;
  nextFireAt: Date;
  lastFiredAt: Date | null;
  lastOutcome: string | null;

  consecutiveFailures: number;
  createdByPrincipalId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class ScheduleError extends Error {
  override readonly name = "ScheduleError";
  constructor(
    message: string,
    readonly code: string,
    readonly status: 400 | 404 | 409 | 422 = 422,
  ) {
    super(message);
  }
}

export function rowToSchedule(row: Record<string, unknown>): Schedule {
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    id: row["id"] as string,
    organizationId: row["organization_id"] as string,
    repositoryId: row["repository_id"] as string,
    name: row["name"] as string,
    cron: row["cron"] as string,
    timezone: row["timezone"] as string,
    title: row["title"] as string,
    description: row["description"] as string,
    riskLevel: row["risk_level"] as RiskLevel,
    spendCapUsd: num(row["spend_cap_usd"]),
    wallClockCapSeconds: num(row["wall_clock_cap_seconds"]),
    enabled: row["enabled"] as boolean,
    nextFireAt: row["next_fire_at"] as Date,
    lastFiredAt: (row["last_fired_at"] as Date | null) ?? null,
    lastOutcome: (row["last_outcome"] as string | null) ?? null,
    consecutiveFailures: Number(row["consecutive_failures"] ?? 0),
    createdByPrincipalId: (row["created_by_principal_id"] as string | null) ?? null,
    createdAt: row["created_at"] as Date,
    updatedAt: row["updated_at"] as Date,
  };
}

export interface ScheduleInput {
  repositoryId?: unknown;
  name?: unknown;
  cron?: unknown;
  timezone?: unknown;
  title?: unknown;
  description?: unknown;
  riskLevel?: unknown;
  spendCapUsd?: unknown;
  wallClockCapSeconds?: unknown;
  enabled?: unknown;
}

interface Normalised {
  repositoryId?: string;
  name?: string;
  cron?: string;
  timezone?: string;
  title?: string;
  description?: string;
  riskLevel?: RiskLevel;
  spendCapUsd?: number | null;
  wallClockCapSeconds?: number | null;
  enabled?: boolean;
}

function normalise(input: ScheduleInput): Normalised {
  const out: Normalised = {};
  const text = (name: keyof ScheduleInput, value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim() === "") {
      throw new ScheduleError(`${name} must be a non-empty string`, "invalid_field", 400);
    }
    return value;
  };
  const set = <K extends keyof Normalised>(key: K, value: Normalised[K] | undefined): void => {
    if (value !== undefined) out[key] = value;
  };
  set("repositoryId", text("repositoryId", input.repositoryId));
  set("name", text("name", input.name)?.trim());
  set("cron", text("cron", input.cron)?.trim());
  set("timezone", text("timezone", input.timezone)?.trim());
  set("title", text("title", input.title));
  set("description", text("description", input.description));
  if (input.riskLevel !== undefined) {
    if (input.riskLevel !== "low" && input.riskLevel !== "medium" && input.riskLevel !== "high") {
      throw new ScheduleError("riskLevel must be low, medium or high", "invalid_field", 400);
    }
    out.riskLevel = input.riskLevel;
  }
  if (input.spendCapUsd !== undefined) {
    const v = input.spendCapUsd;
    if (v !== null && !(typeof v === "number" && Number.isFinite(v) && v > 0)) {
      throw new ScheduleError("spendCapUsd must be a positive number of dollars, or null for the default", "invalid_field", 400);
    }
    out.spendCapUsd = v;
  }
  if (input.wallClockCapSeconds !== undefined) {
    const v = input.wallClockCapSeconds;
    if (v !== null && !(typeof v === "number" && Number.isInteger(v) && v > 0)) {
      throw new ScheduleError("wallClockCapSeconds must be a positive whole number of seconds, or null", "invalid_field", 400);
    }
    out.wallClockCapSeconds = v;
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new ScheduleError("enabled must be true or false", "invalid_field", 400);
    out.enabled = input.enabled;
  }
  return out;
}

export function cronRefusal(error: CronError): ScheduleError {
  return new ScheduleError(error.message, error.code, 422);
}

function firstSlot(cron: string, timezone: string, now: Date): Date {
  try {
    return validateSchedule(cron, timezone, now).next;
  } catch (error) {
    if (error instanceof CronError) throw cronRefusal(error);
    throw error;
  }
}

async function assertGranted(db: Queryable, organizationId: string, repositoryId: string): Promise<void> {
  const { rows } = isUuid(repositoryId)
    ? await db.query("select 1 from repository_grant where organization_id = $1 and repository_id = $2", [
        organizationId,
        repositoryId,
      ])
    : { rows: [] };
  if (rows.length === 0) {
    throw new ScheduleError(
      `repository ${repositoryId} is not granted to this organization`,
      "repository_not_granted",
      422,
    );
  }
}

export async function createSchedule(
  db: Queryable,
  organizationId: string,
  input: ScheduleInput,
  createdByPrincipalId: string | null,
  now = new Date(),
): Promise<Schedule> {
  const n = normalise(input);
  for (const field of ["repositoryId", "name", "cron", "title", "description"] as const) {
    if (n[field] === undefined) throw new ScheduleError(`${field} is required`, "missing_field", 400);
  }
  const timezone = n.timezone ?? "UTC";
  const next = firstSlot(n.cron!, timezone, now);
  await assertGranted(db, organizationId, n.repositoryId!);
  const { rows } = await db.query(
    `insert into schedule
       (organization_id, repository_id, name, cron, timezone, title, description, risk_level,
        spend_cap_usd, wall_clock_cap_seconds, enabled, next_fire_at, created_by_principal_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     returning *`,
    [
      organizationId,
      n.repositoryId,
      n.name,
      n.cron,
      timezone,
      n.title,
      n.description,
      n.riskLevel ?? "low",
      n.spendCapUsd ?? null,
      n.wallClockCapSeconds ?? null,
      n.enabled ?? true,
      next,
      createdByPrincipalId,
    ],
  );
  return rowToSchedule(rows[0]);
}

export async function getSchedule(db: Queryable, organizationId: string, id: string): Promise<Schedule | null> {

  if (!isUuid(id)) return null;
  const { rows } = await db.query("select * from schedule where organization_id = $1 and id = $2", [organizationId, id]);
  return rows[0] ? rowToSchedule(rows[0]) : null;
}

export interface ScheduleFilter {
  cursor?: string | undefined;
  limit?: number | undefined;
}

export async function listSchedules(
  db: Queryable,
  organizationId: string,
  filter: ScheduleFilter = {},
): Promise<Page<Schedule>> {
  const limit = clampLimit(filter.limit);
  const params: unknown[] = [organizationId];
  let after = "";
  if (filter.cursor) {
    const { createdAt, id } = decodeCursor(filter.cursor);
    params.push(createdAt, id);
    after = "and (created_at, id) < ($2, $3)";
  }
  params.push(limit + 1);
  const { rows } = await db.query(
    `select * from schedule where organization_id = $1 ${after}
      order by created_at desc, id desc
      limit $${params.length}`,
    params,
  );
  return paginate(rows.map(rowToSchedule), limit, filter.cursor ?? null);
}

export async function updateSchedule(
  pool: Pool,
  organizationId: string,
  id: string,
  input: ScheduleInput,
  now = new Date(),
): Promise<Schedule | null> {
  if (!isUuid(id)) return null;
  const n = normalise(input);
  return withTransaction(pool, async (client) => {
    const locked = await client.query(
      "select * from schedule where organization_id = $1 and id = $2 for update",
      [organizationId, id],
    );

    if (!locked.rows[0]) return null;
    const current = rowToSchedule(locked.rows[0]);
    if (n.repositoryId !== undefined) await assertGranted(client, organizationId, n.repositoryId);

    const sets: string[] = [];
    const values: unknown[] = [organizationId, id];
    const set = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (n.repositoryId !== undefined) set("repository_id", n.repositoryId);
    if (n.name !== undefined) set("name", n.name);
    if (n.cron !== undefined) set("cron", n.cron);
    if (n.timezone !== undefined) set("timezone", n.timezone);
    if (n.title !== undefined) set("title", n.title);
    if (n.description !== undefined) set("description", n.description);
    if (n.riskLevel !== undefined) set("risk_level", n.riskLevel);
    if (n.spendCapUsd !== undefined) set("spend_cap_usd", n.spendCapUsd);
    if (n.wallClockCapSeconds !== undefined) set("wall_clock_cap_seconds", n.wallClockCapSeconds);
    if (n.enabled !== undefined) set("enabled", n.enabled);

    const reslot =
      (n.cron !== undefined && n.cron !== current.cron) ||
      (n.timezone !== undefined && n.timezone !== current.timezone) ||
      (n.enabled === true && !current.enabled);
    if (reslot) {
      set("next_fire_at", firstSlot(n.cron ?? current.cron, n.timezone ?? current.timezone, now));

      sets.push("consecutive_failures = 0");
    }
    sets.push("updated_at = now()");

    const { rows } = await client.query(
      `update schedule set ${sets.join(", ")} where organization_id = $1 and id = $2 returning *`,
      values,
    );
    return rows[0] ? rowToSchedule(rows[0]) : null;
  });
}

export async function deleteSchedule(db: Queryable, organizationId: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const { rowCount } = await db.query("delete from schedule where organization_id = $1 and id = $2", [organizationId, id]);
  return (rowCount ?? 0) > 0;
}

export function claimNextDueSchedule(db: Queryable, now: Date, reached: readonly string[]): Promise<QueryResult> {
  return db.query(
    `select * from schedule
        where enabled and next_fire_at <= $1 and not (id = any ($2::uuid[]))
        order by next_fire_at, id
        limit 1
        for update skip locked`,
    [now, reached],
  );
}

export function recordSlotOutcome(
  db: Queryable,
  update: {
    scheduleId: string;
    moves: boolean;
    claimedSlot: Date;
    nextFireAt: string;
    created: boolean;
    slot: string;
    outcome: string;
    failures: number;
  },
): Promise<QueryResult> {
  return db.query(
    `update schedule
        set next_fire_at = case when $2 and next_fire_at = $3 then $4::timestamptz else next_fire_at end,
            last_fired_at = case when $5 then $6::timestamptz else last_fired_at end,
            last_outcome = $7,
            consecutive_failures = case when next_fire_at = $3 then $8 else 0 end,
            updated_at = now()
      where id = $1`,
    [update.scheduleId, update.moves, update.claimedSlot, update.nextFireAt, update.created, update.slot, update.outcome, update.failures],
  );
}

export function lockScheduleRow(db: Queryable, scheduleId: string): Promise<QueryResult> {
  return db.query("select 1 from schedule where id = $1 for update", [scheduleId]);
}

export function selectRepositoryGrant(db: Queryable, organizationId: string, repositoryId: string): Promise<QueryResult> {
  return db.query("select 1 from repository_grant where organization_id = $1 and repository_id = $2", [organizationId, repositoryId]);
}

export function selectOtherSlotLiveRuns(
  db: Queryable,
  input: { organizationId: string; sourceType: string; referencePrefix: string; deliveryKey: string; terminal: readonly string[] },
): Promise<QueryResult<{ id: string; status: string; bound: boolean }>> {
  return db.query<{ id: string; status: string; bound: boolean }>(
    `select r.id, r.status,
            exists (select 1 from workflow_run_binding b where b.engineering_run_id = r.id) as bound
       from engineering_task t
       join engineering_run r on r.task_id = t.id
      where t.organization_id = $1
        and t.source_type = $2
        and starts_with(t.source_reference, $3)
        and t.source_reference <> $4
        and r.status <> all ($5::text[])`,
    [input.organizationId, input.sourceType, input.referencePrefix, input.deliveryKey, input.terminal],
  );
}
