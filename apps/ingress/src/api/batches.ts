import {
  batchDetail,
  BatchError,
  batchMaxItems,
  batchProgressFor,
  changeBatchLifecycle,
  getBatch,
  insertBatch,
  listBatches,
  normaliseBatchInput,
  type Batch,
  type BatchItemView,
  type BatchProgress,
} from "@windkeel/factory/batches";
import { dispatchOrganization } from "@windkeel/factory/batches";
import {
  claimIdempotencyKey,
  invalidIdempotencyKey,
  requestHash,
  storeIdempotentResponse,
} from "@windkeel/factory/intake";
import { defaultLog, describeError } from "@windkeel/factory/intake";
import { accepted, badRequest, notFound, ok, type ApiDeps, type ApiResult, type Query, type Scope } from "./handlers.js";
import { transact } from "./transact.js";

function batchView(batch: Batch, progress: BatchProgress) {
  return {
    id: batch.id,
    kind: batch.kind,
    title: batch.title,
    description: batch.description,
    template: batch.template,
    maxConcurrency: batch.maxConcurrency,
    batchSpendCapUsd: batch.batchSpendCapUsd,
    stopOnFailureRatio: batch.stopOnFailureRatio,
    status: batch.status,
    stopReason: batch.stopReason,
    createdByPrincipalId: batch.createdByPrincipalId,
    createdAt: batch.createdAt.toISOString(),
    updatedAt: batch.updatedAt.toISOString(),
    completedAt: batch.completedAt?.toISOString() ?? null,
    progress,
  };
}

function itemView(item: BatchItemView) {
  return {
    id: item.id,
    ordinal: item.ordinal,
    repositoryId: item.repositoryId,
    repositoryFullName: item.repositoryFullName,
    state: item.state,
    skipReason: item.skipReason,
    title: item.spec.title ?? null,
    taskId: item.taskId,
    runId: item.run?.id ?? item.runId,
    runStatus: item.run?.status ?? null,
    finalVerdict: item.run?.finalVerdict ?? null,
    stopReason: item.run?.stopReason ?? null,
    spendCapUsd: item.run?.spendCapUsd ?? null,
    costUsd: item.cost,
    pullRequestNumber: item.run?.prNumber ?? null,
    pullRequestUrl: item.pullRequestUrl,
    dispatchedAt: item.dispatchedAt?.toISOString() ?? null,
  };
}

function refusal(error: unknown): ApiResult {
  if (error instanceof BatchError) {
    return { status: error.status, body: { error: error.message, code: error.code, ...error.detail } };
  }
  throw error;
}

async function dispatchNow(deps: ApiDeps, organizationId: string): Promise<number> {
  try {
    const result = await dispatchOrganization(deps.pool, organizationId, {
      startRun: (runId) => deps.control.enqueue(runId),
    });
    return result.batches.reduce((n, b) => n + b.started.length, 0);
  } catch (error) {
    defaultLog("batch dispatch after a command failed", { organizationId, ...describeError(error) });
    return 0;
  }
}

async function detailOf(deps: ApiDeps, batch: Batch) {
  const { progress, items } = await batchDetail(deps.pool, batch);
  return { batch: batchView(batch, progress), items: items.map(itemView) };
}

export async function batches(deps: ApiDeps, scope: Scope, query: Query): Promise<ApiResult> {
  const rawLimit = query.get("limit");
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  const page = await listBatches(deps.pool, scope.organizationId, {
    status: query.get("status"),
    cursor: query.get("cursor"),
    limit: limit !== undefined && Number.isInteger(limit) ? limit : undefined,
  });
  const progress = await batchProgressFor(deps.pool, page.items);
  return ok({ ...page, items: page.items.map((b) => batchView(b, progress.get(b.id)!)) });
}

export async function batch(deps: ApiDeps, scope: Scope, batchId: string): Promise<ApiResult> {
  const found = await getBatch(deps.pool, scope.organizationId, batchId);
  return found ? ok(await detailOf(deps, found)) : notFound("batch");
}

export async function createBatch(deps: ApiDeps, scope: Scope, body: unknown, idempotencyKey?: string): Promise<ApiResult> {
  let normalised;
  try {
    normalised = normaliseBatchInput(asInput(body), batchMaxItems());
  } catch (error) {
    return refusal(error);
  }
  if (idempotencyKey !== undefined) {
    const invalid = invalidIdempotencyKey(idempotencyKey);
    if (invalid) return badRequest(invalid, "invalid_idempotency_key");
  }
  const hash = requestHash(body);

  let deliveryKey: string | null = null;
  let committed: { created: Batch } | ApiResult;
  try {

    committed = await transact<{ created: Batch }, ApiResult>(deps.pool, async (client, rollback) => {
      if (idempotencyKey !== undefined) {
        const claim = await claimIdempotencyKey(client, {
          principalId: scope.principalId,
          key: `batch:${idempotencyKey}`,
          organizationId: scope.organizationId,
          requestHash: hash,
        });
        if (!claim.claimed) {
          if (claim.requestHash !== hash) {
            return rollback({
              status: 422,
              body: { error: "this Idempotency-Key was already used with a different request body", code: "idempotency_key_reused" },
            });
          }
          if (!claim.response) {
            return rollback({ status: 409, body: { error: "the request this Idempotency-Key made left no answer to replay", code: "idempotency_key_orphaned" } });
          }
          return rollback({ status: claim.response.status, body: claim.response.body, headers: { "idempotent-replayed": "true" } });
        }
        deliveryKey = claim.deliveryKey;
      }
      const created = await insertBatch(client, scope.organizationId, normalised, scope.principalId);
      if (deliveryKey) {
        await storeIdempotentResponse(client, deliveryKey, accepted({ batchId: created.id, started: 0 }));
      }
      return { created };
    });
  } catch (error) {
    if (error instanceof BatchError) return refusal(error);
    throw error;
  }
  if (!("created" in committed)) return committed;
  const { created } = committed;

  const started = await dispatchNow(deps, scope.organizationId);
  const fresh = (await getBatch(deps.pool, scope.organizationId, created.id)) ?? created;
  const detail = await detailOf(deps, fresh);
  const result = accepted({ batchId: created.id, started, ...detail });
  if (deliveryKey) {
    await storeIdempotentResponse(deps.pool, deliveryKey, { status: result.status, body: result.body }).catch((err: unknown) =>
      defaultLog("idempotent response not stored", { deliveryKey, ...describeError(err) }),
    );
  }
  return result;
}

export async function pauseBatch(deps: ApiDeps, scope: Scope, batchId: string): Promise<ApiResult> {
  return lifecycle(deps, scope, batchId, "pause");
}

export async function resumeBatch(deps: ApiDeps, scope: Scope, batchId: string): Promise<ApiResult> {
  return lifecycle(deps, scope, batchId, "resume");
}

export async function cancelBatch(deps: ApiDeps, scope: Scope, batchId: string): Promise<ApiResult> {
  return lifecycle(deps, scope, batchId, "cancel");
}

async function lifecycle(deps: ApiDeps, scope: Scope, batchId: string, action: "pause" | "resume" | "cancel"): Promise<ApiResult> {
  let changed;
  try {
    changed = await changeBatchLifecycle(deps.pool, scope.organizationId, batchId, action);
  } catch (error) {
    return refusal(error);
  }
  if (!changed) return notFound("batch");
  const cancelled: Array<{ runId: string; outcome: string }> = [];
  for (const runId of changed.cancelRuns) {
    try {
      const outcome = await deps.control.cancel(runId, `batch ${batchId} cancelled by ${scope.actor}`, scope.actor);
      cancelled.push({ runId, outcome: outcome.outcome });
    } catch (error) {
      defaultLog("batch child cancel failed", { batchId, engineeringRunId: runId, ...describeError(error) });
      cancelled.push({ runId, outcome: "failed" });
    }
  }
  const started = action === "resume" ? await dispatchNow(deps, scope.organizationId) : 0;
  const fresh = (await getBatch(deps.pool, scope.organizationId, batchId)) ?? changed.batch;
  return accepted({ batchId, started, ...(action === "cancel" ? { cancelled } : {}), ...(await detailOf(deps, fresh)) });
}

function asInput(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}
