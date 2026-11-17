
import type { Queryable } from "../db/transaction.js";

type Row = Record<string, unknown>;

export async function upsertRunCaptureRow(
  db: Queryable,
  v: { engineeringRunId: string; bucket: string; objectKey: string; byteTotal: number; capturedAt: Date },
): Promise<Row> {
  const { rows } = await db.query(
    `insert into run_capture (engineering_run_id, bucket, object_key, byte_total, captured_at, pruned_at)
     values ($1, $2, $3, $4, $5, null)
     on conflict (engineering_run_id) do update
       set bucket = excluded.bucket,
           object_key = excluded.object_key,
           byte_total = excluded.byte_total,
           captured_at = excluded.captured_at,
           pruned_at = null
     returning *`,
    [v.engineeringRunId, v.bucket, v.objectKey, v.byteTotal, v.capturedAt],
  );
  return rows[0];
}

export async function selectRunCaptureRow(db: Queryable, engineeringRunId: string): Promise<Row | undefined> {
  const { rows } = await db.query("select * from run_capture where engineering_run_id = $1", [engineeringRunId]);
  return rows[0];
}

export async function selectPrunableCaptureRows(db: Queryable, now: Date, retentionDays: number): Promise<Row[]> {
  const { rows } = await db.query(
    `select * from run_capture
      where pruned_at is null
        and captured_at <= $1::timestamptz - ($2::int * interval '1 day')
      order by captured_at`,
    [now, retentionDays],
  );
  return rows;
}

export async function markRunCapturePruned(db: Queryable, engineeringRunId: string, now: Date, capturedAt: Date): Promise<number> {
  const { rowCount } = await db.query(
    `update run_capture set pruned_at = $2
      where engineering_run_id = $1 and pruned_at is null
        and date_trunc('milliseconds', captured_at) = $3`,
    [engineeringRunId, now, capturedAt],
  );
  return rowCount ?? 0;
}
