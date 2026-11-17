

import type { Pool, PoolClient, QueryResult } from "pg";
import type { RiskLevel } from "../factory/rails.js";
import type { RunState } from "../factory/run-state-machine.js";
import { isUuid } from "../factory/tenancy.js";
import { clampLimit, decodeCursor, paginate, type Page } from "../factory/api-queries.js";
import { withTransaction } from "../factory/db/transaction.js";
import type { NormalisedBatch } from "./batch-input.js";
import {
  holdsBudget,
  isFailed,
  isSettled,
  isSucceeded,
  occupiesSlot,
} from "./rails.js";

type Queryable = Pool | PoolClient;

export type BatchKind = "fanout" | "multi_repo";
export type BatchStatus = "RUNNING" | "PAUSED" | "STOPPING" | "COMPLETED" | "PARTIAL" | "FAILED" | "CANCELLED";
export type BatchStopReasonValue = "batch_spend_cap" | "failure_ratio" | "cancelled";
export type BatchItemState = "pending" | "dispatched" | "skipped";

const TERMINAL_BATCH_STATUSES: ReadonlySet<BatchStatus> = new Set(["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"]);

export interface BatchTemplate {
  riskLevel: RiskLevel;

  criteria: string[];

  spendCapUsd?: number;
  wallClockCapSeconds?: number;
}

export interface Batch {
  id: string;
  organizationId: string;
  kind: BatchKind;
  title: string;
  description: string;
  template: BatchTemplate;
  maxConcurrency: number;
  batchSpendCapUsd: number | null;
  stopOnFailureRatio: number | null;
  status: BatchStatus;
  stopReason: BatchStopReasonValue | null;
  createdByPrincipalId: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BatchItemSpec {
  title?: string;
  description?: string;
  criteria?: string[];
}

export interface BatchItem {
  id: string;
  batchId: string;
  ordinal: number;
  repositoryId: string;
  taskId: string | null;
  runId: string | null;
  state: BatchItemState;
  skipReason: string | null;
  spec: BatchItemSpec;
  dispatchedAt: Date | null;
}

export class BatchError extends Error {
  override readonly name = "BatchError";
  constructor(
    message: string,
    readonly code: string,
    readonly status: 400 | 404 | 409 | 422 = 422,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function rowToBatch(row: Record<string, unknown>): Batch {
  const template = (row["template"] ?? {}) as Partial<BatchTemplate>;
  return {
    id: row["id"] as string,
    organizationId: row["organization_id"] as string,
    kind: row["kind"] as BatchKind,
    title: row["title"] as string,
    description: row["description"] as string,
    template: {
      riskLevel: template.riskLevel ?? "low",
      criteria: template.criteria ?? [],
      ...(template.spendCapUsd !== undefined ? { spendCapUsd: template.spendCapUsd } : {}),
      ...(template.wallClockCapSeconds !== undefined ? { wallClockCapSeconds: template.wallClockCapSeconds } : {}),
    },
    maxConcurrency: Number(row["max_concurrency"]),
    batchSpendCapUsd: num(row["batch_spend_cap_usd"]),
    stopOnFailureRatio: num(row["stop_on_failure_ratio"]),
    status: row["status"] as BatchStatus,
    stopReason: (row["stop_reason"] as BatchStopReasonValue | null) ?? null,
    createdByPrincipalId: (row["created_by_principal_id"] as string | null) ?? null,
    completedAt: (row["completed_at"] as Date | null) ?? null,
    createdAt: row["created_at"] as Date,
    updatedAt: row["updated_at"] as Date,
  };
}

export function rowToBatchItem(row: Record<string, unknown>): BatchItem {
  return {
    id: row["id"] as string,
    batchId: row["batch_id"] as string,
    ordinal: Number(row["ordinal"]),
    repositoryId: row["repository_id"] as string,
    taskId: (row["task_id"] as string | null) ?? null,
    runId: (row["run_id"] as string | null) ?? null,
    state: row["state"] as BatchItemState,
    skipReason: (row["skip_reason"] as string | null) ?? null,
    spec: (row["spec"] ?? {}),
    dispatchedAt: (row["dispatched_at"] as Date | null) ?? null,
  };
}

async function assertGranted(db: Queryable, organizationId: string, repositoryIds: readonly string[]): Promise<void> {
  const ids = [...new Set(repositoryIds)];
  const valid = ids.filter(isUuid);
  const { rows } = valid.length
    ? await db.query<{ repository_id: string }>(
        "select repository_id from repository_grant where organization_id = $1 and repository_id = any($2::uuid[])",
        [organizationId, valid],
      )
    : { rows: [] };
  const granted = new Set(rows.map((r) => r.repository_id));
  const ungranted = ids.filter((id) => !granted.has(id));
  if (ungranted.length > 0) {
    throw new BatchError(
      `${ungranted.length === 1 ? "repository" : "repositories"} ${ungranted.join(", ")} ${ungranted.length === 1 ? "is" : "are"} not granted to this organization`,
      "repository_not_granted",
      422,
      { ungranted },
    );
  }
}

export async function insertBatch(
  db: Queryable,
  organizationId: string,
  batch: NormalisedBatch,
  createdByPrincipalId: string | null,
): Promise<Batch> {
  await assertGranted(db, organizationId, batch.items.map((i) => i.repositoryId));
  const { rows } = await db.query(
    `insert into batch
       (organization_id, kind, title, description, template, max_concurrency, batch_spend_cap_usd,
        stop_on_failure_ratio, created_by_principal_id)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
     returning *`,
    [
      organizationId,
      batch.kind,
      batch.title,
      batch.description,
      JSON.stringify(batch.template),
      batch.maxConcurrency,
      batch.batchSpendCapUsd,
      batch.stopOnFailureRatio,
      createdByPrincipalId,
    ],
  );
  const created = rowToBatch(rows[0]);
  await db.query(
    `insert into batch_item (batch_id, ordinal, repository_id, spec)
     select $1, ord - 1, repo, spec
       from unnest($2::uuid[], $3::jsonb[]) with ordinality as t(repo, spec, ord)`,
    [created.id, batch.items.map((i) => i.repositoryId), batch.items.map((i) => JSON.stringify(i.spec))],
  );
  return created;
}

export async function getBatch(db: Queryable, organizationId: string, id: string): Promise<Batch | null> {
  if (!isUuid(id)) return null;
  const { rows } = await db.query("select * from batch where organization_id = $1 and id = $2", [organizationId, id]);
  return rows[0] ? rowToBatch(rows[0]) : null;
}

export interface BatchFilter {
  status?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export async function listBatches(db: Queryable, organizationId: string, filter: BatchFilter = {}): Promise<Page<Batch>> {
  const limit = clampLimit(filter.limit);
  const params: unknown[] = [organizationId];
  const where = ["organization_id = $1"];
  if (filter.status) {
    params.push(filter.status.split(",").map((s) => s.trim()).filter(Boolean));
    where.push(`status = any($${params.length})`);
  }
  if (filter.cursor) {
    const { createdAt, id } = decodeCursor(filter.cursor);
    params.push(createdAt, id);
    where.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`);
  }
  params.push(limit + 1);
  const { rows } = await db.query(
    `select * from batch where ${where.join(" and ")}
      order by created_at desc, id desc
      limit $${params.length}`,
    params,
  );
  return paginate(rows.map(rowToBatch), limit, filter.cursor ?? null);
}

export async function changeBatchLifecycle(
  pool: Pool,
  organizationId: string,
  id: string,
  action: "pause" | "resume" | "cancel",
): Promise<{ batch: Batch; cancelRuns: string[] } | null> {
  if (!isUuid(id)) return null;
  return withTransaction(pool, async (client) => {
    const locked = await client.query("select * from batch where organization_id = $1 and id = $2 for update", [organizationId, id]);

    if (!locked.rows[0]) return null;
    const current = rowToBatch(locked.rows[0]);
    const refuse = (why: string): never => {
      throw new BatchError(`cannot ${action} a batch that is ${current.status}${why}`, "invalid_batch_state", 409);
    };
    let updated: Batch;
    let cancelRuns: string[] = [];
    if (action === "pause") {
      if (current.status !== "RUNNING") refuse("");
      updated = await setStatus(client, id, "PAUSED");
    } else if (action === "resume") {
      if (current.status !== "PAUSED") refuse("");
      updated = await setStatus(client, id, "RUNNING");
    } else {
      if (TERMINAL_BATCH_STATUSES.has(current.status)) refuse("; it has already settled");
      await client.query(
        `update batch_item set state = 'skipped', skip_reason = 'batch_cancelled' where batch_id = $1 and state = 'pending'`,
        [id],
      );
      updated = await setStatus(client, id, "CANCELLED", "cancelled");
      const { rows } = await client.query<{ id: string; status: RunState }>(
        `select r.id, r.status from engineering_run r join engineering_task t on t.id = r.task_id where t.batch_id = $1`,
        [id],
      );

      cancelRuns = rows.filter((r) => occupiesSlot(r.status)).map((r) => r.id);
    }
    return { batch: updated, cancelRuns };
  });
}

export async function setStatus(
  db: Queryable,
  id: string,
  status: BatchStatus,
  stopReason?: BatchStopReasonValue,
): Promise<Batch> {
  const { rows } = await db.query(
    `update batch set status = $2,
            stop_reason = coalesce($3, stop_reason),
            completed_at = case when $4 then now() else completed_at end,
            updated_at = now()
      where id = $1 returning *`,
    [id, status, stopReason ?? null, TERMINAL_BATCH_STATUSES.has(status)],
  );
  return rowToBatch(rows[0]);
}

export interface ChildRun {
  id: string;
  taskId: string;
  status: RunState;
  finalVerdict: string | null;
  stopReason: string | null;
  cost: number;
  spendCapUsd: number | null;
  prNumber: number | null;
  createdAt: Date;
}

export interface BatchItemView extends BatchItem {
  repositoryFullName: string;

  run: ChildRun | null;

  cost: number;
  pullRequestUrl: string | null;
}

export interface BatchProgress {
  items: number;
  pending: number;
  dispatched: number;
  skipped: number;

  active: number;
  settled: number;
  succeeded: number;
  failed: number;

  byStatus: Partial<Record<RunState, number>>;

  verdicts: { pass: number; warn: number; fail: number; none: number };

  totalCostUsd: number;

  reservedUsd: number;

  remainingBudgetUsd: number | null;
}

export function summariseBatch(
  batch: Pick<Batch, "batchSpendCapUsd">,
  items: readonly BatchItem[],
  runs: readonly ChildRun[],
): BatchProgress {
  const byTask = new Map<string, ChildRun[]>();
  for (const run of runs) {
    const list = byTask.get(run.taskId) ?? [];
    list.push(run);
    byTask.set(run.taskId, list);
  }
  const progress: BatchProgress = {
    items: items.length,
    pending: 0,
    dispatched: 0,
    skipped: 0,
    active: 0,
    settled: 0,
    succeeded: 0,
    failed: 0,
    byStatus: {},
    verdicts: { pass: 0, warn: 0, fail: 0, none: 0 },
    totalCostUsd: 0,
    reservedUsd: 0,
    remainingBudgetUsd: null,
  };
  for (const run of runs) {
    progress.totalCostUsd += run.cost;
    if (occupiesSlot(run.status)) progress.active += 1;

    if (holdsBudget(run.status) && run.spendCapUsd !== null) {
      progress.reservedUsd += Math.max(0, run.spendCapUsd - run.cost);
    }
  }
  for (const item of items) {
    progress[item.state] += 1;
    const newest = item.taskId ? newestRun(byTask.get(item.taskId) ?? []) : null;
    if (!newest) continue;
    progress.byStatus[newest.status] = (progress.byStatus[newest.status] ?? 0) + 1;
    const verdict = newest.finalVerdict;
    if (verdict === "pass" || verdict === "warn" || verdict === "fail") progress.verdicts[verdict] += 1;
    else progress.verdicts.none += 1;
    if (isSettled(newest.status)) {
      progress.settled += 1;
      if (isSucceeded(newest.status, newest.finalVerdict)) progress.succeeded += 1;
      if (isFailed(newest.status)) progress.failed += 1;
    }
  }
  progress.totalCostUsd = round(progress.totalCostUsd);
  progress.reservedUsd = round(progress.reservedUsd);
  if (batch.batchSpendCapUsd !== null) {
    progress.remainingBudgetUsd = round(Math.max(0, batch.batchSpendCapUsd - progress.totalCostUsd - progress.reservedUsd));
  }
  return progress;
}

function newestRun(runs: readonly ChildRun[]): ChildRun | null {
  let newest: ChildRun | null = null;
  for (const run of runs) {
    if (!newest || run.createdAt.getTime() > newest.createdAt.getTime() || (run.createdAt.getTime() === newest.createdAt.getTime() && run.id > newest.id)) {
      newest = run;
    }
  }
  return newest;
}

function round(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}

export async function loadBatchChildren(
  db: Queryable,
  batchId: string,
): Promise<{ items: Array<BatchItem & { repositoryFullName: string }>; runs: ChildRun[] }> {
  const items = await db.query(
    `select bi.*, repo.owner, repo.name
       from batch_item bi join repository repo on repo.id = bi.repository_id
      where bi.batch_id = $1
      order by bi.ordinal`,
    [batchId],
  );
  const runs = await db.query(
    `select r.id, r.task_id, r.status, r.final_verdict, r.stop_reason, r.cost, r.spend_cap_usd, r.pr_number, r.created_at
       from engineering_run r join engineering_task t on t.id = r.task_id
      where t.batch_id = $1`,
    [batchId],
  );
  return {
    items: items.rows.map((row) => ({
      ...rowToBatchItem(row),
      repositoryFullName: `${row["owner"] as string}/${row["name"] as string}`,
    })),
    runs: runs.rows.map((row) => ({
      id: row["id"] as string,
      taskId: row["task_id"] as string,
      status: row["status"] as RunState,
      finalVerdict: (row["final_verdict"] as string | null) ?? null,
      stopReason: (row["stop_reason"] as string | null) ?? null,
      cost: Number(row["cost"]),
      spendCapUsd: num(row["spend_cap_usd"]),
      prNumber: (row["pr_number"] as number | null) ?? null,
      createdAt: (row["created_at"] as Date | null) ?? new Date(0),
    })),
  };
}

export async function batchDetail(
  db: Queryable,
  batch: Batch,
): Promise<{ progress: BatchProgress; items: BatchItemView[] }> {
  const { items, runs } = await loadBatchChildren(db, batch.id);
  const progress = summariseBatch(batch, items, runs);
  const byTask = new Map<string, ChildRun[]>();
  for (const run of runs) byTask.set(run.taskId, [...(byTask.get(run.taskId) ?? []), run]);
  return {
    progress,
    items: items.map((item) => {
      const taskRuns = item.taskId ? byTask.get(item.taskId) ?? [] : [];
      const run = newestRun(taskRuns);
      const pr = run?.prNumber ?? taskRuns.find((r) => r.prNumber !== null)?.prNumber ?? null;
      return {
        ...item,
        run,
        cost: round(taskRuns.reduce((sum, r) => sum + r.cost, 0)),
        pullRequestUrl: pr !== null ? `https://github.com/${item.repositoryFullName}/pull/${pr}` : null,
      };
    }),
  };
}

export async function batchProgressFor(db: Queryable, batches: readonly Batch[]): Promise<Map<string, BatchProgress>> {
  const out = new Map<string, BatchProgress>();
  for (const batch of batches) {
    const { items, runs } = await loadBatchChildren(db, batch.id);
    out.set(batch.id, summariseBatch(batch, items, runs));
  }
  return out;
}

export async function batchOfRun(db: Queryable, organizationId: string, runId: string): Promise<{ id: string; title: string } | null> {
  if (!isUuid(runId)) return null;
  const { rows } = await db.query<{ id: string; title: string }>(
    `select b.id, b.title from engineering_run r
       join engineering_task t on t.id = r.task_id
       join batch b on b.id = t.batch_id
      where r.id = $1 and t.organization_id = $2`,
    [runId, organizationId],
  );
  return rows[0] ?? null;
}

export function selectCurrentSchema(db: Queryable): Promise<QueryResult<{ schema: string }>> {
  return db.query<{ schema: string }>("select current_schema() as schema");
}

export function takeAdvisoryXactLock(db: Queryable, namespace: number, key: number): Promise<QueryResult> {
  return db.query("select pg_advisory_xact_lock($1, $2)", [namespace, key]);
}

export function lockLiveBatches(db: Queryable, organizationId: string): Promise<QueryResult> {
  return db.query(
    `select * from batch where organization_id = $1 and status in ('RUNNING', 'STOPPING')
        order by created_at, id for update`,
    [organizationId],
  );
}

export function selectOrganizationMaxConcurrentRuns(
  db: Queryable,
  organizationId: string,
): Promise<QueryResult<{ max_concurrent_runs: number | null }>> {
  return db.query<{ max_concurrent_runs: number | null }>("select max_concurrent_runs from organization where id = $1", [organizationId]);
}

export function countOrganizationLiveRuns(db: Queryable, organizationId: string): Promise<QueryResult<{ status: RunState; n: string }>> {
  return db.query<{ status: RunState; n: string }>(
    `select r.status, count(*) as n
       from engineering_run r join engineering_task t on t.id = r.task_id
      where t.organization_id = $1
        and r.status not in ('COMPLETED', 'CANCELLED', 'FAILED', 'MAX_REPAIR_ATTEMPTS_REACHED')
      group by r.status`,
    [organizationId],
  );
}

export function claimPendingItems(db: Queryable, batchId: string, limit: number): Promise<QueryResult> {
  return db.query(
    `select * from batch_item where batch_id = $1 and state = 'pending'
                  order by ordinal limit $2 for update skip locked`,
    [batchId, limit],
  );
}

export function skipItemNotGranted(db: Queryable, itemId: string): Promise<QueryResult> {
  return db.query(`update batch_item set state = 'skipped', skip_reason = 'repository_not_granted' where id = $1`, [itemId]);
}

export function setTaskBatch(db: Queryable, taskId: string, batchId: string): Promise<QueryResult> {
  return db.query("update engineering_task set batch_id = $2 where id = $1", [taskId, batchId]);
}

export function markItemDispatched(db: Queryable, itemId: string, taskId: string, runId: string): Promise<QueryResult> {
  return db.query(`update batch_item set state = 'dispatched', task_id = $2, run_id = $3, dispatched_at = now() where id = $1`, [
    itemId,
    taskId,
    runId,
  ]);
}

export function skipPendingItemsStopped(db: Queryable, batchId: string): Promise<QueryResult<{ ordinal: number }>> {
  return db.query<{ ordinal: number }>(
    `update batch_item set state = 'skipped', skip_reason = 'batch_stopped'
            where batch_id = $1 and state = 'pending' returning ordinal`,
    [batchId],
  );
}

export function selectOrganizationsWithLiveBatches(db: Queryable): Promise<QueryResult<{ organization_id: string }>> {
  return db.query<{ organization_id: string }>("select distinct organization_id from batch where status in ('RUNNING', 'STOPPING')");
}
