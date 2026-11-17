
import type { Queryable } from "../db/transaction.js";

type Row = Record<string, unknown>;

const SELECT = `select id, seq, at, actor, message, delivered_at, undeliverable_reason,
                       delivery_attempts
                  from run_guidance`;

export async function insertGuidanceRow(
  db: Queryable,
  input: { engineeringRunId: string; actor: string; message: string; actorPrincipalId: string | null },
): Promise<Row> {
  const { rows } = await db.query(
    `insert into run_guidance (engineering_run_id, actor, message, actor_principal_id)
       values ($1, $2, $3, $4)
       returning id, seq, at, actor, message, delivered_at, undeliverable_reason, delivery_attempts`,
    [input.engineeringRunId, input.actor, input.message, input.actorPrincipalId],
  );
  return rows[0]!;
}

export async function selectGuidanceRows(db: Queryable, engineeringRunId: string): Promise<Row[]> {
  const { rows } = await db.query(`${SELECT} where engineering_run_id = $1 order by seq asc`, [
    engineeringRunId,
  ]);
  return rows;
}

export async function giveUpExhaustedGuidance(db: Queryable, engineeringRunId: string, maxAttempts: number): Promise<void> {
  await db.query(
    `update run_guidance
        set undeliverable_reason = 'claimed ' || delivery_attempts ||
            ' times without a confirmed delivery; the worker did not survive long enough to ' ||
            'hand it to the agent. Say it again, or cancel the run.'
      where engineering_run_id = $1
        and delivered_at is null
        and undeliverable_reason is null
        and delivery_attempts >= $2`,
    [engineeringRunId, maxAttempts],
  );
}

export async function bumpPendingGuidanceRows(db: Queryable, engineeringRunId: string): Promise<Row[]> {
  const { rows } = await db.query(
    `update run_guidance set delivery_attempts = delivery_attempts + 1
       where engineering_run_id = $1
         and delivered_at is null
         and undeliverable_reason is null
       returning id, seq, actor, message`,
    [engineeringRunId],
  );
  return rows;
}

export async function markGuidanceRowsDelivered(db: Queryable, ids: readonly string[]): Promise<void> {
  await db.query(`update run_guidance set delivered_at = now() where id = any($1::uuid[])`, [ids]);
}

export async function markGuidanceRowsUndeliverable(db: Queryable, ids: readonly string[], reason: string): Promise<void> {
  await db.query(`update run_guidance set undeliverable_reason = $2 where id = any($1::uuid[])`, [
    ids,
    reason,
  ]);
}
