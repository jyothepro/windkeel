
import type { Queryable } from "../../db/transaction.js";

type Row = Record<string, unknown>;

const REAPABLE_SQL = `
  select w.id,
         w.engineering_run_id,
         w.role,
         w.sandbox_provider,
         w.provider_handle,
         w.status,
         case
           when r.status = any($1::text[]) then 'run_terminal'
           when w.status = 'orphaned'      then 'orphaned'
           else 'expired'
         end as because
    from workspace w
    join engineering_run r on r.id = w.engineering_run_id
   where w.provider_handle is not null
     and w.status <> 'destroyed'
     and w.reap_attempts < $3
     and (
           r.status = any($1::text[])
        or w.status = 'orphaned'
        or (w.expires_at is not null and w.expires_at < $2)
     )
   order by w.id`;

export async function selectReapableWorkspaces(
  db: Queryable,
  terminalStates: Iterable<string>,
  now: Date,
  maxAttempts: number,
): Promise<Row[]> {
  const { rows } = await db.query(REAPABLE_SQL, [[...terminalStates], now, maxAttempts]);
  return rows;
}

export async function bumpReapAttempts(db: Queryable, workspaceId: string): Promise<number> {
  const { rows } = await db.query(
    "update workspace set reap_attempts = reap_attempts + 1 where id = $1 returning reap_attempts",
    [workspaceId],
  );
  return (rows[0]?.["reap_attempts"] as number) ?? 0;
}

export async function selectRunsWithStaleSignals(
  db: Queryable,
  minimumAgeMs: number,
): Promise<Array<{ engineering_run_id: string; waiting: string }>> {
  const { rows } = await db.query<{ engineering_run_id: string; waiting: string }>(
    `select s.engineering_run_id, count(*)::text as waiting
       from run_signal s
       join engineering_run r on r.id = s.engineering_run_id
      where s.consumed_at is null
        and s.received_at < now() - ($1::bigint * interval '1 millisecond')
        and r.status not in (
          'COMPLETED', 'CANCELLED', 'FAILED', 'MAX_REPAIR_ATTEMPTS_REACHED'
        )
      group by s.engineering_run_id`,
    [String(minimumAgeMs)],
  );
  return rows;
}

export async function failStaleMerges(
  db: Queryable,
  ageMs: number,
  batch: number,
  reason: string,
): Promise<Array<{ id: string; engineering_run_id: string }>> {
  const { rows } = await db.query<{ id: string; engineering_run_id: string }>(
    `update run_merge set status = 'failed', reason = $3, completed_at = now()
      where id in (
        select id from run_merge
         where status = 'pending'
           and coalesce(heartbeat_at, created_at) < now() - ($1::bigint * interval '1 millisecond')
         order by created_at
         limit $2
         for update skip locked)
        and status = 'pending'
      returning id, engineering_run_id`,
    [String(ageMs), batch, reason],
  );
  return rows;
}

export async function selectStalledBindings(
  db: Queryable,
  stalledForMs: number,
  batch: number,
): Promise<Array<{ id: string; phase: string; updated_at: Date; status: string }>> {
  const { rows } = await db.query<{ id: string; phase: string; updated_at: Date; status: string }>(
    `select b.engineering_run_id as id, b.phase, b.updated_at, r.status
       from workflow_run_binding b
       join engineering_run r on r.id = b.engineering_run_id
      where b.phase in ('queued', 'running', 'retrying', 'waiting')
        and b.updated_at < now() - ($1::bigint * interval '1 millisecond')
      order by b.updated_at
      limit $2`,
    [String(stalledForMs), batch],
  );
  return rows;
}

export async function selectStrandedCreatedRuns(
  db: Queryable,
  minimumAgeMs: number,
  maximumAgeMs: number,
  batch: number,
): Promise<Array<{ id: string; created_at: Date; source_type: string }>> {
  const { rows } = await db.query<{ id: string; created_at: Date; source_type: string }>(
    `select r.id, r.created_at, t.source_type
       from engineering_run r
       join engineering_task t on t.id = r.task_id
      where r.status = 'CREATED'
        and r.created_at < now() - ($1::bigint * interval '1 millisecond')
        and r.created_at > now() - ($2::bigint * interval '1 millisecond')
        and not exists (select 1 from workflow_run_binding b where b.engineering_run_id = r.id)
      order by r.created_at
      limit $3`,
    [String(minimumAgeMs), String(maximumAgeMs), batch],
  );
  return rows;
}

export async function selectUnverifiedCredentials(
  db: Queryable,
  minimumAgeMs: number,
  maximumAgeMs: number,
  batch: number,
): Promise<Array<{ id: string; organization_id: string }>> {
  const { rows } = await db.query<{ id: string; organization_id: string }>(
    `select id, organization_id
       from model_credential
      where status = 'unverified'
        and revoked_at is null
        and updated_at < now() - ($1::bigint * interval '1 millisecond')
        and updated_at > now() - ($2::bigint * interval '1 millisecond')
      order by updated_at
      limit $3`,
    [String(minimumAgeMs), String(maximumAgeMs), batch],
  );
  return rows;
}
