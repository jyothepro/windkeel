

import type { Pool, PoolClient } from "pg";
import { createTaskFromIntake } from "../intake/create-task.js";
import { withTransaction } from "../factory/db/transaction.js";
import { defaultLog, describeError, type IntakeLog } from "../factory/log.js";
import { DEFAULT_SPEND_CAP_USD } from "../factory/rails.js";
import { organizationHoldsGrant } from "../factory/tenancy.js";
import { WINDKEEL_ADVISORY_NAMESPACE, sweepLockKey, withSweepLock, type LockOutcome } from "../factory/sweeps/advisory-lock.js";
import {
  batchFreeSlots,
  batchOutcome,
  batchStopReason,
  childSpendCap,
  DEFAULT_ORG_MAX_CONCURRENT_RUNS,
  holdsBudget,
  occupiesSlot,
  positiveIntFromEnv,
} from "./rails.js";
import {
  claimPendingItems,
  countOrganizationLiveRuns,
  loadBatchChildren,
  lockLiveBatches,
  markItemDispatched,
  rowToBatch,
  rowToBatchItem,
  selectCurrentSchema,
  selectOrganizationMaxConcurrentRuns,
  selectOrganizationsWithLiveBatches,
  setStatus,
  setTaskBatch,
  skipItemNotGranted,
  skipPendingItemsStopped,
  summariseBatch,
  takeAdvisoryXactLock,
  type Batch,
  type BatchItem,
  type BatchStatus,
} from "./store.js";

const BATCHES_SWEEP = "batches";

export const BATCH_SOURCE_TYPE = "batch";

export interface DispatchDeps {

  startRun(engineeringRunId: string): Promise<{ enqueued: boolean }>;
  log?: IntakeLog;

  env?: Record<string, string | undefined>;
}

export interface BatchDispatched {
  batchId: string;

  started: Array<{ ordinal: number; taskId: string; runId: string; spendCapUsd: number }>;

  skipped: Array<{ ordinal: number; reason: string }>;
  status: BatchStatus;
  stopReason: string | null;
}

export interface OrganizationDispatch {
  organizationId: string;
  batches: BatchDispatched[];

  enqueueFailed: string[];
}

function childReference(batchId: string, ordinal: number): string {
  return `batch:${batchId}:${ordinal}`;
}

export function childDescription(batch: Pick<Batch, "description" | "template">, item: Pick<BatchItem, "spec">): string {
  const description = item.spec.description ?? batch.description;
  const criteria = [...batch.template.criteria, ...(item.spec.criteria ?? [])];
  if (criteria.length === 0) return description;
  return `${description.trimEnd()}\n\n## Acceptance criteria\n\n${criteria.map((c) => `- [ ] ${c}`).join("\n")}\n`;
}

function childTitle(batch: Pick<Batch, "title">, item: Pick<BatchItem, "spec">): string {
  return item.spec.title ?? batch.title;
}

async function orgLimit(db: PoolClient, organizationId: string, env: Record<string, string | undefined>): Promise<number> {
  const { rows } = await selectOrganizationMaxConcurrentRuns(db, organizationId);
  const own = rows[0]?.max_concurrent_runs;
  if (own !== null && own !== undefined) return Number(own);
  return positiveIntFromEnv(env["WINDKEEL_DEFAULT_ORG_MAX_CONCURRENT_RUNS"], DEFAULT_ORG_MAX_CONCURRENT_RUNS);
}

async function orgActiveRuns(db: PoolClient, organizationId: string): Promise<number> {
  const { rows } = await countOrganizationLiveRuns(db, organizationId);
  return rows.filter((r) => occupiesSlot(r.status)).reduce((sum, r) => sum + Number(r.n), 0);
}

export async function dispatchOrganization(
  pool: Pool,
  organizationId: string,
  deps: DispatchDeps,
): Promise<OrganizationDispatch> {
  const log = deps.log ?? defaultLog;
  const env = deps.env ?? process.env;
  const result: OrganizationDispatch = { organizationId, batches: [], enqueueFailed: [] };
  const toEnqueue: Array<() => Promise<{ enqueued: boolean }>> = [];
  const runIds: string[] = [];

  await withTransaction(pool, async (client) => {
    const schema = (await selectCurrentSchema(client)).rows[0]?.schema ?? "public";
    await takeAdvisoryXactLock(client, WINDKEEL_ADVISORY_NAMESPACE, sweepLockKey(`${BATCHES_SWEEP}:${organizationId}`, schema));
    const live = await lockLiveBatches(client, organizationId);
    if (live.rows.length === 0) return;
    const limit = await orgLimit(client, organizationId, env);
    let orgActive = await orgActiveRuns(client, organizationId);

    for (const row of live.rows) {
      let batch = rowToBatch(row);
      const outcome: BatchDispatched = { batchId: batch.id, started: [], skipped: [], status: batch.status, stopReason: batch.stopReason };
      const { items, runs } = await loadBatchChildren(client, batch.id);
      const progress = summariseBatch(batch, items, runs);
      let active = progress.active;
      let reserved = progress.reservedUsd;

      let holding = runs.filter((r) => holdsBudget(r.status)).length;

      if (batch.status === "RUNNING" && progress.pending > 0) {
        const stop = batchStopReason({
          spend: progress.totalCostUsd,
          cap: batch.batchSpendCapUsd,
          settled: progress.settled,
          failed: progress.failed,
          ratio: batch.stopOnFailureRatio,
        });
        if (stop) {
          batch = await setStatus(client, batch.id, "STOPPING", stop);
          log("batch stopping", { batchId: batch.id, stopReason: stop, spentUsd: progress.totalCostUsd, failed: progress.failed, settled: progress.settled });
        }
      }

      let pending = progress.pending;
      if (batch.status === "RUNNING" && pending > 0) {
        const free = batchFreeSlots({ maxConcurrency: batch.maxConcurrency, active, orgMaxConcurrentRuns: limit, orgActive });
        const claimed = free === 0
          ? []
          : (await claimPendingItems(client, batch.id, free)).rows.map(rowToBatchItem);
        for (const item of claimed) {
          const remaining = batch.batchSpendCapUsd === null ? null : batch.batchSpendCapUsd - progress.totalCostUsd - reserved;
          const cap = childSpendCap(remaining, batch.template.spendCapUsd ?? DEFAULT_SPEND_CAP_USD);
          if (cap === null) {

            if (holding === 0) {
              batch = await setStatus(client, batch.id, "STOPPING", "batch_spend_cap");
              log("batch stopping", { batchId: batch.id, stopReason: "batch_spend_cap", spentUsd: progress.totalCostUsd });
            }
            break;
          }

          if (!(await organizationHoldsGrant(client, organizationId, item.repositoryId))) {
            await skipItemNotGranted(client, item.id);
            outcome.skipped.push({ ordinal: item.ordinal, reason: "repository_not_granted" });
            pending -= 1;
            continue;
          }
          const created = await createTaskFromIntake(
            client,
            {
              organizationId,
              repositoryId: item.repositoryId,
              sourceType: BATCH_SOURCE_TYPE,
              sourceReference: childReference(batch.id, item.ordinal),
              sourceContext: { batchId: batch.id, ordinal: item.ordinal },
              title: childTitle(batch, item),
              description: childDescription(batch, item),
              riskLevel: batch.template.riskLevel,

              createdByPrincipalId: batch.createdByPrincipalId,
              rails: {
                spendCapUsd: cap,
                ...(batch.template.wallClockCapSeconds !== undefined ? { wallClockCapSeconds: batch.template.wallClockCapSeconds } : {}),
              },
            },
            { startRun: deps.startRun },
          );
          await setTaskBatch(client, created.taskId, batch.id);
          await markItemDispatched(client, item.id, created.taskId, created.runId);
          outcome.started.push({ ordinal: item.ordinal, taskId: created.taskId, runId: created.runId, spendCapUsd: cap });
          toEnqueue.push(created.afterCommit);
          runIds.push(created.runId);
          reserved += cap;
          holding += 1;
          active += 1;
          orgActive += 1;
          pending -= 1;
        }
      }

      if (batch.status === "STOPPING" && pending > 0) {

        const skipped = await skipPendingItemsStopped(client, batch.id);
        for (const s of skipped.rows) outcome.skipped.push({ ordinal: Number(s.ordinal), reason: "batch_stopped" });
        pending = 0;
      }

      if ((batch.status === "RUNNING" || batch.status === "STOPPING") && pending === 0 && active === 0) {
        const after = await loadBatchChildren(client, batch.id);
        const final = summariseBatch(batch, after.items, after.runs);
        batch = await setStatus(client, batch.id, batchOutcome({ items: final.items, succeeded: final.succeeded }));
        log("batch settled", { batchId: batch.id, status: batch.status, succeeded: final.succeeded, items: final.items, totalCostUsd: final.totalCostUsd });
      }
      outcome.status = batch.status;
      outcome.stopReason = batch.stopReason;
      result.batches.push(outcome);
    }
  });

  for (let i = 0; i < toEnqueue.length; i += 1) {
    try {
      await toEnqueue[i]!();
    } catch (error) {
      result.enqueueFailed.push(runIds[i]!);

      log("batch child enqueue failed", { engineeringRunId: runIds[i], ...describeError(error) });
    }
  }
  return result;
}

export async function dispatchBatches(pool: Pool, deps: DispatchDeps): Promise<LockOutcome<OrganizationDispatch[]>> {
  const log = deps.log ?? defaultLog;
  return withSweepLock(pool, BATCHES_SWEEP, async () => {
    const { rows } = await selectOrganizationsWithLiveBatches(pool);
    const out: OrganizationDispatch[] = [];
    for (const row of rows) {
      try {
        out.push(await dispatchOrganization(pool, row.organization_id, deps));
      } catch (error) {
        log("batch dispatch failed", { organizationId: row.organization_id, ...describeError(error) });
      }
    }
    return out;
  });
}
