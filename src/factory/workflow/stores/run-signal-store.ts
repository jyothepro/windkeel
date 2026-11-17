
import type { Pool, PoolClient } from "pg";

type Db = Pool | PoolClient;

export async function insertRunSignal(
  db: Db,
  engineeringRunId: string,
  kind: string,
  payload: string,
): Promise<{ id: string } | undefined> {
  const { rows } = await db.query(
    "insert into run_signal (engineering_run_id, kind, payload) values ($1, $2, $3) returning id",
    [engineeringRunId, kind, payload],
  );
  return rows[0];
}

export async function hasUnconsumedSignal(db: Db, engineeringRunId: string): Promise<boolean> {
  const { rows } = await db.query(
    "select 1 from run_signal where engineering_run_id = $1 and consumed_at is null limit 1",
    [engineeringRunId],
  );
  return rows.length > 0;
}

export async function countUnconsumedSignals(db: Db, engineeringRunId: string): Promise<Array<{ n: number }>> {
  const { rows } = await db.query(
    "select count(*)::int as n from run_signal where engineering_run_id = $1 and consumed_at is null",
    [engineeringRunId],
  );
  return rows;
}

export async function signalOrCancellationSince(db: Db, engineeringRunId: string, since: Date): Promise<boolean> {
  const { rows } = await db.query(
    `select exists (
                select 1 from run_signal
                 where engineering_run_id = $1 and consumed_at is null and received_at >= $2
              )
           or exists (select 1 from run_cancellation where engineering_run_id = $1) as arrived`,
    [engineeringRunId, since],
  );
  return rows[0]?.arrived === true;
}

export interface TakenSignalRow {
  id: string;
  engineering_run_id: string;
  kind: string;
  payload: unknown;
  received_at: Date;
}

export async function consumeSignals(db: Db, engineeringRunId: string): Promise<TakenSignalRow[]> {
  const { rows } = await db.query(
    `update run_signal
         set consumed_at = now()
       where id in (
         select id from run_signal
         where engineering_run_id = $1 and consumed_at is null
         order by received_at
         for update skip locked
       )
       returning id, engineering_run_id, kind, payload, received_at`,
    [engineeringRunId],
  );
  return rows;
}

export async function insertCancellation(db: Db, engineeringRunId: string, reason: string): Promise<void> {
  await db.query(
    `insert into run_cancellation (engineering_run_id, reason) values ($1, $2)
       on conflict (engineering_run_id) do nothing`,
    [engineeringRunId, reason],
  );
}

export async function selectCancellation(db: Db, engineeringRunId: string): Promise<unknown[]> {
  const { rows } = await db.query("select 1 from run_cancellation where engineering_run_id = $1", [
    engineeringRunId,
  ]);
  return rows;
}
