
import type { Queryable } from "../db/transaction.js";

type Row = Record<string, unknown>;

export async function selectLiveHumanSessionRow(db: Queryable, engineeringRunId: string): Promise<Row | undefined> {
  const { rows } = await db.query("select * from human_session where engineering_run_id = $1 and ended_at is null", [engineeringRunId]);
  return rows[0];
}

export async function selectHumanSessionRows(db: Queryable, engineeringRunId: string): Promise<Row[]> {
  const { rows } = await db.query("select * from human_session where engineering_run_id = $1 order by requested_at, id", [engineeringRunId]);
  return rows;
}

export async function selectHumanSessionRow(db: Queryable, id: string): Promise<Row | undefined> {
  const { rows } = await db.query("select * from human_session where id = $1", [id]);
  return rows[0];
}

export interface HumanSessionInsert {
  engineeringRunId: string;
  principalId: string | null;
  actor: string;
  githubUserId: number;
  githubLogin: string;
  displayName: string | null;
  origin: string;
  requestedFrom: string;
}

export async function insertHumanSessionRow(db: Queryable, input: HumanSessionInsert): Promise<Row> {
  const { rows } = await db.query(
    `insert into human_session
       (engineering_run_id, principal_id, actor, github_user_id, github_login, display_name, origin, requested_from)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
    [
      input.engineeringRunId,
      input.principalId,
      input.actor,
      input.githubUserId,
      input.githubLogin,
      input.displayName,
      input.origin,
      input.requestedFrom,
    ],
  );
  return rows[0];
}

export async function updateHumanSessionRow(db: Queryable, sets: readonly string[], values: readonly unknown[]): Promise<Row> {
  const { rows } = await db.query(`update human_session set ${sets.join(", ")} where id = $${values.length} returning *`, [...values]);
  return rows[0];
}

export async function queueHumanIntentRow(db: Queryable, sessionId: string, intent: string): Promise<Row | undefined> {
  const { rows } = await db.query(
    `update human_session set intent = $2, intent_at = now()
      where id = $1 and ended_at is null and intent is null and state in ('ready', 'sleeping')
      returning *`,
    [sessionId, intent],
  );
  return rows[0];
}

export async function expireRequestedTakeovers(db: Queryable, engineeringRunId: string, reason: string): Promise<number> {
  const { rowCount } = await db.query(
    `update human_session
        set state = 'ended', outcome = 'expired', ended_at = now(), error = $2
      where engineering_run_id = $1 and ended_at is null and origin = 'takeover' and state = 'requested'`,
    [engineeringRunId, reason],
  );
  return rowCount ?? 0;
}

export async function selectPendingHandbackRow(db: Queryable, engineeringRunId: string): Promise<Row | undefined> {
  const { rows } = await db.query(
    `select * from human_session
      where engineering_run_id = $1 and outcome = 'handed_back' and resumed_at is null
      order by ended_at desc limit 1`,
    [engineeringRunId],
  );
  return rows[0];
}

export async function selectHumanCyclesRow(db: Queryable, engineeringRunId: string): Promise<Row | undefined> {
  const { rows } = await db.query("select human_cycles, human_cycles_cap from engineering_run where id = $1", [engineeringRunId]);
  return rows[0];
}

export async function incrementHumanCyclesRow(db: Queryable, engineeringRunId: string): Promise<void> {
  await db.query("update engineering_run set human_cycles = human_cycles + 1 where id = $1", [engineeringRunId]);
}

export async function selectTaskSessionModeRow(db: Queryable, taskId: string): Promise<Row | undefined> {
  const { rows } = await db.query("select session_mode, pair_principal_id from engineering_task where id = $1", [taskId]);
  return rows[0];
}

export async function updateTaskSessionModeRow(db: Queryable, taskId: string, mode: string, pairPrincipalId: string | null): Promise<void> {
  await db.query("update engineering_task set session_mode = $2, pair_principal_id = $3 where id = $1", [taskId, mode, pairPrincipalId]);
}

export async function selectPrincipalGithubIdentityRow(db: Queryable, principalId: string): Promise<Row | undefined> {
  const { rows } = await db.query(
    "select github_user_id, github_login, display_name from principal where id = $1",
    [principalId],
  );
  return rows[0];
}
