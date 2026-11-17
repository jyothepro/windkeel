
import type { Queryable } from "../../db/transaction.js";

type Row = Record<string, unknown>;

export async function selectAccountsPastAuditRetention(db: Queryable, defaultDays: number, now: Date): Promise<Row[]> {
  const { rows } = await db.query(
    `select a.id, coalesce(p.audit_retention_days, $1::int) as days
       from account a left join account_security_policy p on p.account_id = a.id
      where exists (select 1 from audit_event e
                     where e.account_id = a.id
                       and e.occurred_at < $2::timestamptz - make_interval(days => coalesce(p.audit_retention_days, $1::int)))
      order by a.id`,
    [defaultDays, now],
  );
  return rows;
}

export async function deleteStaleSessionActivity(db: Queryable, now: Date, days: number): Promise<number> {
  const { rowCount } = await db.query(
    "delete from session_activity where last_seen_at < $1::timestamptz - make_interval(days => $2::int)",
    [now, days],
  );
  return rowCount ?? 0;
}

export async function selectAccountsBehindSink(db: Queryable): Promise<Row[]> {
  const { rows } = await db.query(
    `select a.id, coalesce(c.last_seq, 0) as last_seq
       from account a left join audit_sink_cursor c on c.account_id = a.id
      where exists (select 1 from audit_event e where e.account_id = a.id and e.seq > coalesce(c.last_seq, 0))
      order by a.id`,
  );
  return rows;
}

export async function recordSinkSuccess(db: Queryable, accountId: string, lastSeq: unknown): Promise<void> {
  await db.query(
    `insert into audit_sink_cursor (account_id, last_seq, last_success_at, last_error, failures, updated_at)
     values ($1, $2, now(), null, 0, now())
     on conflict (account_id) do update set last_seq = greatest(audit_sink_cursor.last_seq, excluded.last_seq),
       last_success_at = now(), last_error = null, failures = 0, updated_at = now()`,
    [accountId, lastSeq],
  );
}

export async function recordSinkFailure(db: Queryable, accountId: string, lastSeq: number, error: string): Promise<void> {
  await db.query(
    `insert into audit_sink_cursor (account_id, last_seq, last_error, failures, updated_at)
     values ($1, $2, $3, 1, now())
     on conflict (account_id) do update set last_error = excluded.last_error,
       failures = audit_sink_cursor.failures + 1, updated_at = now()`,
    [accountId, lastSeq, error],
  );
}
