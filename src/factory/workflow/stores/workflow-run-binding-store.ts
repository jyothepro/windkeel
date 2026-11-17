

import type { Pool, PoolClient } from "pg";

type Db = Pool | PoolClient;

export type BindingPhase = "queued" | "running" | "waiting" | "retrying" | "finished";

export async function selectBindingProviderPhase(
  db: Db,
  engineeringRunId: string,
): Promise<Array<{ provider: string; phase: string }>> {
  const { rows } = await db.query<{ provider: string; phase: string }>(
    "select provider, phase from workflow_run_binding where engineering_run_id = $1",
    [engineeringRunId],
  );
  return rows;
}

export async function upsertBackingBinding(
  db: Db,
  engineeringRunId: string,
  backing: string,
  executionHandle: string,
): Promise<void> {
  await db.query(
    `insert into workflow_run_binding
         (engineering_run_id, provider, execution_handle, phase, attempt, started_at, updated_at)
       values ($1, $2, $3, 'queued', 1, now(), now())
       on conflict (engineering_run_id) do update
         set execution_handle = excluded.execution_handle,
             phase = 'queued',
             updated_at = now()
         where workflow_run_binding.provider = excluded.provider`,
    [engineeringRunId, backing, executionHandle],
  );
}

export async function countLiveBindingsByProvider(db: Db): Promise<Array<{ provider: string; n: number }>> {
  const { rows } = await db.query(
    `select provider, count(*)::int as n
       from workflow_run_binding
      where phase <> 'finished'
      group by provider`,
  );
  return rows as Array<{ provider: string; n: number }>;
}

export async function claimBindingForStart(
  db: Db,
  engineeringRunId: string,
  provider: string,
  executionToken: string,
): Promise<number | null> {
  const { rowCount } = await db.query(
    `insert into workflow_run_binding
         (engineering_run_id, provider, execution_handle, execution_token, phase, attempt, started_at, updated_at)
       values ($1, $2, '', $3, 'queued', 1, now(), now())
       on conflict (engineering_run_id) do update
         set provider = excluded.provider,
             execution_handle = '',
             execution_token = excluded.execution_token,
             phase = 'queued',
             attempt = 1,
             -- The column describes the execution the row currently names, and this row is about
             -- to name a new one. A run adopted after running out of ticks is not still out of
             -- ticks; leaving it set would make every later reading of the table wrong.
             tick_budget_exhausted_at = null,
             started_at = now(),
             updated_at = now()
         where workflow_run_binding.phase = 'finished'`,
    [engineeringRunId, provider, executionToken],
  );
  return rowCount;
}

export async function deleteUnstartedBinding(db: Db, engineeringRunId: string): Promise<void> {
  await db.query("delete from workflow_run_binding where engineering_run_id = $1 and execution_handle = ''", [
    engineeringRunId,
  ]);
}

export async function setBindingHandle(db: Db, engineeringRunId: string, executionHandle: string): Promise<void> {
  await db.query(
    `update workflow_run_binding
          set execution_handle = $2, updated_at = now()
        where engineering_run_id = $1 and execution_handle = ''`,
    [engineeringRunId, executionHandle],
  );
}

export async function releaseStaleBinding(db: Db, stale: string, staleArgs: string[]): Promise<number | null> {
  const { rowCount } = await db.query(
    `update workflow_run_binding set phase = 'finished', attempt = 1, updated_at = now() where ${stale}`,
    staleArgs,
  );
  return rowCount;
}

export async function reclaimStaleBinding(
  db: Db,
  stale: string,
  staleArgs: string[],
  executionToken: string,
  maxReclaims: number,
): Promise<Array<{ reclaim_count: number }>> {
  const { rows } = await db.query(
    `update workflow_run_binding
          set phase = 'queued', execution_handle = '', execution_token = $4, attempt = 1,
              reclaim_count = reclaim_count + 1, reclaimed_at = now(),
              tick_budget_exhausted_at = null, started_at = now(), updated_at = now()
        where ${stale} and reclaim_count < $5
        returning reclaim_count`,
    [...staleArgs, executionToken, maxReclaims],
  );
  return rows;
}

export async function setReclaimedBindingHandle(
  db: Db,
  engineeringRunId: string,
  executionHandle: string,
  executionToken: string,
): Promise<void> {
  await db.query(
    `update workflow_run_binding set execution_handle = $2, updated_at = now()
        where engineering_run_id = $1 and execution_token = $3 and execution_handle = ''`,
    [engineeringRunId, executionHandle, executionToken],
  );
}

export async function finishExhaustedStaleBinding(
  db: Db,
  stale: string,
  staleArgs: string[],
  executionToken: string,
  maxReclaims: number,
): Promise<Array<{ reclaim_count: number; reclaimed_at: Date | null }>> {
  const { rows } = await db.query(
    `update workflow_run_binding
          set phase = 'finished', attempt = 1, execution_token = $4, updated_at = now()
        where ${stale} and reclaim_count >= $5
        returning reclaim_count, reclaimed_at`,
    [...staleArgs, executionToken, maxReclaims],
  );
  return rows;
}

export async function resetReclaimCount(db: Db, engineeringRunId: string, executionToken: string | null): Promise<void> {
  await db.query(
    `update workflow_run_binding set reclaim_count = 0
        where engineering_run_id = $1 and reclaim_count > 0
          and execution_token is not distinct from $2::uuid`,
    [engineeringRunId, executionToken],
  );
}

export async function markTickBudgetExhausted(
  db: Db,
  engineeringRunId: string,
  executionToken: string | null,
): Promise<void> {
  await db.query(
    `update workflow_run_binding
          set phase = 'finished', attempt = 1, tick_budget_exhausted_at = now(), updated_at = now()
        where engineering_run_id = $1 and execution_token is not distinct from $2::uuid`,
    [engineeringRunId, executionToken],
  );
}

export async function touchOwnedBinding(
  db: Db,
  engineeringRunId: string,
  executionToken: string | null,
): Promise<number | null> {
  const { rowCount } = await db.query(
    `update workflow_run_binding set updated_at = now()
        where engineering_run_id = $1 and execution_token is not distinct from $2::uuid`,
    [engineeringRunId, executionToken],
  );
  return rowCount;
}

export async function bindingExists(db: Db, engineeringRunId: string): Promise<boolean> {
  const { rows } = await db.query("select 1 from workflow_run_binding where engineering_run_id = $1", [
    engineeringRunId,
  ]);
  return rows.length > 0;
}

export async function selectBindingToken(
  db: Db,
  engineeringRunId: string,
): Promise<{ execution_token: string | null } | undefined> {
  const { rows } = await db.query(
    "select execution_token from workflow_run_binding where engineering_run_id = $1",
    [engineeringRunId],
  );
  return rows[0];
}

export async function updateBindingPhase(
  db: Db,
  engineeringRunId: string,
  phase: BindingPhase,
  attempt: number,
  fence: [executionToken?: string],
): Promise<Date | null> {
  const fenced = fence.length > 0;
  const { rows } = await db.query(
    `update workflow_run_binding
          set phase = $2, attempt = $3, updated_at = now()
        where engineering_run_id = $1
          ${fenced ? "and execution_token is not distinct from $4::uuid" : ""}
        returning now() as at`,
    fenced ? [engineeringRunId, phase, attempt, fence[0] ?? null] : [engineeringRunId, phase, attempt],
  );
  return (rows[0]?.at as Date | undefined) ?? null;
}

export async function selectBinding(
  db: Db,
  engineeringRunId: string,
): Promise<{ executionHandle: string; phase: string; attempt: number } | null> {
  const { rows } = await db.query(
    "select execution_handle, phase, attempt from workflow_run_binding where engineering_run_id = $1",
    [engineeringRunId],
  );
  if (!rows[0]) return null;
  return {
    executionHandle: rows[0].execution_handle as string,
    phase: rows[0].phase as string,
    attempt: rows[0].attempt as number,
  };
}
