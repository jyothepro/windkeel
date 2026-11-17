

import type { Pool, PoolClient } from "pg";
import type { RunState } from "../run-state-machine.js";
import { TERMINAL_STATES } from "../run-state-machine.js";
import type { EngineeringTask } from "../repositories.js";
import type { KeySource } from "../model-policy.js";

type Queryable = Pool | PoolClient;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export interface Page<T> {
  items: T[];
  endCursor: string | null;
  hasNextPage: boolean;
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new InvalidPageCursorError(cursor);
  }
  const split = decoded.indexOf("|");
  if (split <= 0) throw new InvalidPageCursorError(cursor);
  const createdAt = new Date(decoded.slice(0, split));
  const id = decoded.slice(split + 1);
  if (Number.isNaN(createdAt.getTime()) || id === "") throw new InvalidPageCursorError(cursor);
  return { createdAt, id };
}

export class InvalidPageCursorError extends Error {
  constructor(readonly cursor: string) {
    super(`not a page cursor: ${JSON.stringify(cursor)}`);
    this.name = "InvalidPageCursorError";
  }
}

export function clampLimit(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(requested) || requested < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(requested, MAX_PAGE_SIZE);
}

export function paginate<T extends { id: string; createdAt: Date }>(
  rows: T[],
  limit: number,
  fallback: string | null,
): Page<T> {
  const hasNextPage = rows.length > limit;
  const items = hasNextPage ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    endCursor: last ? encodeCursor(last.createdAt, last.id) : fallback,
    hasNextPage,
  };
}

export interface TaskFilter {

  organizationId: string;
  repositoryId?: string | undefined;
  status?: string | undefined;
  sourceType?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export async function listTasksPage(db: Queryable, filter: TaskFilter): Promise<Page<EngineeringTask>> {
  const limit = clampLimit(filter.limit);
  const where: string[] = [];
  const params: unknown[] = [];
  const bind = (value: unknown): string => `$${params.push(value)}`;

  where.push(`organization_id = ${bind(filter.organizationId)}`);

  if (filter.repositoryId) where.push(`repository_id = ${bind(filter.repositoryId)}`);
  if (filter.status) where.push(`status = ${bind(filter.status)}`);
  if (filter.sourceType) where.push(`source_type = ${bind(filter.sourceType)}`);
  if (filter.cursor) {
    const { createdAt, id } = decodeCursor(filter.cursor);
    where.push(`(created_at, id) < (${bind(createdAt)}, ${bind(id)})`);
  }

  const { rows } = await db.query(
    `select * from engineering_task
     ${where.length ? `where ${where.join(" and ")}` : ""}
     order by created_at desc, id desc
     limit ${bind(limit + 1)}`,
    params,
  );
  return paginate(rows.map(rowToTaskSummary), limit, filter.cursor ?? null);
}

export interface RunFilter {

  organizationId: string;
  taskId?: string | undefined;
  repositoryId?: string | undefined;

  batchId?: string | undefined;
  status?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listRunsPage(db: Queryable, filter: RunFilter): Promise<Page<RunSummary>> {
  const limit = clampLimit(filter.limit);
  const where: string[] = [];
  const params: unknown[] = [];
  const bind = (value: unknown): string => `$${params.push(value)}`;

  where.push(`t.organization_id = ${bind(filter.organizationId)}`);

  if (filter.taskId) where.push(`r.task_id = ${bind(filter.taskId)}`);

  const statuses = (filter.status ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (statuses.length === 1) where.push(`r.status = ${bind(statuses[0])}`);
  else if (statuses.length > 1) where.push(`r.status = any(${bind(statuses)})`);
  if (filter.repositoryId) {
    where.push(
      `r.task_id in (select id from engineering_task where repository_id = ${bind(filter.repositoryId)})`,
    );
  }
  if (filter.batchId !== undefined) {
    if (UUID_SHAPE.test(filter.batchId)) where.push(`t.batch_id = ${bind(filter.batchId)}`);
    else where.push("false");
  }
  if (filter.cursor) {
    const { createdAt, id } = decodeCursor(filter.cursor);
    where.push(`(r.created_at, r.id) < (${bind(createdAt)}, ${bind(id)})`);
  }

  const { rows } = await db.query(
    `select r.*, t.title as task_title, t.repository_id as repository_id
       from engineering_run r
       join engineering_task t on t.id = r.task_id
     ${where.length ? `where ${where.join(" and ")}` : ""}
     order by r.created_at desc, r.id desc
     limit ${bind(limit + 1)}`,
    params,
  );
  return paginate(rows.map(rowToRunSummary), limit, filter.cursor ?? null);
}

export async function listQueue(
  db: Queryable,
  organizationId: string,
  limit: number = DEFAULT_PAGE_SIZE,
): Promise<RunSummary[]> {
  const waiting: RunState[] = ["CREATED", "CLASSIFYING", "PLANNING", "WAITING_FOR_APPROVAL"];
  const { rows } = await db.query(
    `select r.*, t.title as task_title, t.repository_id as repository_id
       from engineering_run r
       join engineering_task t on t.id = r.task_id
      where r.status = any($1) and t.organization_id = $3
      order by r.created_at asc, r.id asc
      limit $2`,
    [waiting, clampLimit(limit), organizationId],
  );
  return rows.map(rowToRunSummary);
}

export interface RepositorySummary {
  id: string;
  createdAt: Date;
  fullName: string;
  defaultBranch: string | null;
  openRuns: number;
}

export async function listRepositoriesPage(
  db: Queryable,
  organizationId: string,
  cursor?: string,
  limit?: number,
): Promise<Page<RepositorySummary>> {
  const size = clampLimit(limit);
  const params: unknown[] = [];
  const bind = (value: unknown): string => `$${params.push(value)}`;
  const org = bind(organizationId);
  let where = `where repo.id in (select repository_id from repository_grant where organization_id = ${org})`;
  if (cursor) {
    const decoded = decodeCursor(cursor);
    where += ` and (repo.created_at, repo.id) < (${bind(decoded.createdAt)}, ${bind(decoded.id)})`;
  }
  const { rows } = await db.query(
    `select repo.id, repo.created_at, repo.owner, repo.name, repo.default_branch,
            (select count(*) from engineering_run r
               join engineering_task t on t.id = r.task_id
              where t.repository_id = repo.id and t.organization_id = ${org} and not (r.status = any($${params.push(
                Array.from(TERMINAL_STATES),
              )}))) as open_runs
       from repository repo
       ${where}
       order by repo.created_at desc, repo.id desc
       limit ${bind(size + 1)}`,
    params,
  );
  return paginate(
    rows.map((row) => ({
      id: row["id"] as string,
      createdAt: row["created_at"] as Date,
      fullName: `${row["owner"] as string}/${row["name"] as string}`,
      defaultBranch: (row["default_branch"] as string | null) ?? null,
      openRuns: Number(row["open_runs"]),
    })),
    size,
    cursor ?? null,
  );
}

export interface CostBreakdown {

  totalUsd: number;

  unpricedEvents: number;
  byStage: CostBreakdownRow[];

  bySource: CostSourceRow[];
}

export interface CostBreakdownRow {
  stageType: string;
  kind: string;

  keySource: KeySource | null;
  usd: number;
  tokensIn: number | null;
  tokensOut: number | null;
  events: number;
  unpricedEvents: number;
}

export interface CostSourceRow {
  keySource: KeySource | null;
  usd: number;
  tokensIn: number | null;
  tokensOut: number | null;
  events: number;
  unpricedEvents: number;
}

export async function runCostBreakdown(db: Queryable, engineeringRunId: string): Promise<CostBreakdown> {
  const { rows } = await db.query(
    `select stage_type, kind, key_source,
            coalesce(sum(usd), 0) as usd,
            sum(tokens_in) as tokens_in,
            sum(tokens_out) as tokens_out,
            count(*) as events,
            count(*) filter (where usd is null) as unpriced
       from cost_event
      where engineering_run_id = $1
      group by stage_type, kind, key_source
      order by stage_type, kind, case key_source when 'orqon' then 0 when 'customer' then 1 else 2 end`,
    [engineeringRunId],
  );
  const byStage = rows.map((row) => ({
    stageType: row["stage_type"] as string,
    kind: row["kind"] as string,
    keySource: (row["key_source"] as KeySource | null) ?? null,
    usd: Number(row["usd"]),

    tokensIn: row["tokens_in"] === null ? null : Number(row["tokens_in"]),
    tokensOut: row["tokens_out"] === null ? null : Number(row["tokens_out"]),
    events: Number(row["events"]),
    unpricedEvents: Number(row["unpriced"]),
  }));
  const bySource: CostSourceRow[] = [];
  for (const row of byStage) {
    if (row.kind !== "model") continue;
    let source = bySource.find((s) => s.keySource === row.keySource);
    if (!source) {
      source = { keySource: row.keySource, usd: 0, tokensIn: null, tokensOut: null, events: 0, unpricedEvents: 0 };
      bySource.push(source);
    }
    source.usd += row.usd;
    if (row.tokensIn !== null) source.tokensIn = (source.tokensIn ?? 0) + row.tokensIn;
    if (row.tokensOut !== null) source.tokensOut = (source.tokensOut ?? 0) + row.tokensOut;
    source.events += row.events;
    source.unpricedEvents += row.unpricedEvents;
  }
  const order = (source: KeySource | null) => (source === "orqon" ? 0 : source === "customer" ? 1 : 2);
  bySource.sort((x, y) => order(x.keySource) - order(y.keySource));
  return {
    totalUsd: byStage.reduce((sum, row) => sum + row.usd, 0),
    unpricedEvents: byStage.reduce((sum, row) => sum + row.unpricedEvents, 0),
    byStage,
    bySource,
  };
}

export interface RunSummary {
  id: string;
  createdAt: Date;
  taskId: string;
  taskTitle: string;
  repositoryId: string;
  status: RunState;
  terminal: boolean;
  finalVerdict: string | null;
  stopReason: string | null;
  cost: number;
  spendCapUsd: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  prNumber: number | null;
  prMergedAt: Date | null;
}

function rowToRunSummary(row: Record<string, unknown>): RunSummary {
  const status = row["status"] as RunState;
  return {
    id: row["id"] as string,
    createdAt: row["created_at"] as Date,
    taskId: row["task_id"] as string,
    taskTitle: row["task_title"] as string,
    repositoryId: row["repository_id"] as string,
    status,
    terminal: TERMINAL_STATES.has(status),
    finalVerdict: (row["final_verdict"] as string | null) ?? null,
    stopReason: (row["stop_reason"] as string | null) ?? null,
    cost: Number(row["cost"]),
    spendCapUsd: row["spend_cap_usd"] === null ? null : Number(row["spend_cap_usd"]),
    startedAt: (row["started_at"] as Date | null) ?? null,
    completedAt: (row["completed_at"] as Date | null) ?? null,
    prNumber: (row["pr_number"] as number | null) ?? null,
    prMergedAt: (row["pr_merged_at"] as Date | null) ?? null,
  };
}

function rowToTaskSummary(row: Record<string, unknown>): EngineeringTask {
  return {
    id: row["id"] as string,
    repositoryId: row["repository_id"] as string,
    sourceType: row["source_type"] as EngineeringTask["sourceType"],
    sourceReference: row["source_reference"] as string,
    title: row["title"] as string,
    description: row["description"] as string,
    acceptanceCriteria: row["acceptance_criteria"] as EngineeringTask["acceptanceCriteria"],
    criteriaProvenance: row["criteria_provenance"] as EngineeringTask["criteriaProvenance"],
    criteriaGeneratedBy: (row["criteria_generated_by"] as string | null) ?? null,
    criteriaApprovedBy: (row["criteria_approved_by"] as string | null) ?? null,
    criteriaApprovedAt: (row["criteria_approved_at"] as Date | null) ?? null,
    organizationId: row["organization_id"] as string,
    createdByPrincipalId: (row["created_by_principal_id"] as string | null | undefined) ?? null,
    sourceContext: (row["source_context"] as Record<string, unknown> | null | undefined) ?? {},
    modelOverride: (row["model_override"] as EngineeringTask["modelOverride"] | undefined) ?? null,
    playbook: (row["playbook"] as EngineeringTask["playbook"] | undefined) ?? null,
    riskLevel: row["risk_level"] as EngineeringTask["riskLevel"],
    priority: (row["priority"] as number | null) ?? null,
    status: row["status"] as EngineeringTask["status"],
    createdAt: row["created_at"] as Date,
    updatedAt: row["updated_at"] as Date,
  };
}
