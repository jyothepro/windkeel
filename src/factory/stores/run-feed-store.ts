
import type { Queryable } from "../db/transaction.js";

type Row = Record<string, unknown>;

export async function selectSettledTransitionHead(db: Queryable, settleSeconds: number): Promise<unknown> {
  const { rows } = await db.query(
    `select seq from run_state_transition
      where at <= now() - make_interval(secs => $1)
      order by seq desc
      limit 1`,
    [settleSeconds],
  );
  return rows[0]?.["seq"];
}

export async function selectRunChangeRows(
  db: Queryable,
  organizationId: string,
  cursor: string,
  window: number,
  settleSeconds: number,
): Promise<Row[]> {
  const { rows } = await db.query(
    `with recent as (
       select t.seq, t.engineering_run_id, t.from_state, t.to_state, t.at,
              t.at <= now() - make_interval(secs => $4) as settled
         from run_state_transition t
        where t.seq > $2
        order by t.seq
        limit $3
     )
     select recent.seq, recent.engineering_run_id, recent.from_state, recent.to_state, recent.at, recent.settled,
            r.task_id, (k.organization_id = $1) as mine
       from recent
       join engineering_run r on r.id = recent.engineering_run_id
       join engineering_task k on k.id = r.task_id
      order by recent.seq`,
    [organizationId, cursor, window, settleSeconds],
  );
  return rows;
}

export async function selectFeedRowsAfter(db: Queryable, feed: string, engineeringRunId: string, cursor: string, limit: number): Promise<Row[]> {
  const { rows } = await db.query(
    `select * from (
       ${feed}
     ) feed
     order by seq asc
     limit $3`,
    [engineeringRunId, cursor, limit],
  );
  return rows;
}

export async function selectFeedRowsBefore(
  db: Queryable,
  feed: string,
  engineeringRunId: string,
  before: string | null,
  limit: number,
): Promise<Row[]> {
  const { rows } = await db.query(
    `select * from (
       ${feed}
     ) feed
     order by seq desc
     limit $3`,
    [engineeringRunId, before, limit],
  );
  return rows;
}
