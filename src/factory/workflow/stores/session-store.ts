

import type { Pool, PoolClient } from "pg";

type Db = Pool | PoolClient;
type Row = Record<string, unknown>;

export async function selectSessionBindingRow(db: Db, engineeringRunId: string): Promise<Row | undefined> {
  const { rows } = await db.query(
    "select worker_type, session_ref, resumable from worker_session_binding where engineering_run_id = $1",
    [engineeringRunId],
  );
  return rows[0];
}

export async function upsertSessionBinding(
  db: Db,
  engineeringRunId: string,
  workerType: string,
  sessionRefJson: string,
  resumable: boolean,
): Promise<void> {
  await db.query(
    `insert into worker_session_binding
       (engineering_run_id, worker_type, session_ref, resumable, started_at, updated_at)
     values ($1, $2, $3, $4, now(), now())
     on conflict (engineering_run_id) do update
       set worker_type = excluded.worker_type,
           session_ref = excluded.session_ref,
           resumable = excluded.resumable,
           updated_at = now()`,
    [engineeringRunId, workerType, sessionRefJson, resumable],
  );
}

export async function deleteSessionBinding(db: Db, engineeringRunId: string): Promise<void> {
  await db.query("delete from worker_session_binding where engineering_run_id = $1", [
    engineeringRunId,
  ]);
}

export async function selectSessionProgressRow(db: Db, agentRunId: string): Promise<Row | undefined> {
  const { rows } = await db.query(
    "select summary, session_ref, polls, turn_ended_at from agent_session_progress where agent_run_id = $1",
    [agentRunId],
  );
  return rows[0];
}

export interface SessionProgressValues {
  agentRunId: string;
  engineeringRunId: string;
  summaryJson: string;
  sessionRefJson: string | null;
  polls: number;
  turnEnded: boolean;
}

export async function upsertSessionProgress(db: Db, v: SessionProgressValues): Promise<void> {
  await db.query(
    `insert into agent_session_progress
       (agent_run_id, engineering_run_id, summary, session_ref, polls, turn_ended_at, started_at, updated_at)
     values ($1, $2, $3, $4, $5, case when $6::boolean then now() end, now(), now())
     on conflict (agent_run_id) do update
       set summary = excluded.summary,
           session_ref = excluded.session_ref,
           polls = excluded.polls,
           turn_ended_at = case when $6::boolean
                                then coalesce(agent_session_progress.turn_ended_at, now()) end,
           updated_at = now()`,
    [v.agentRunId, v.engineeringRunId, v.summaryJson, v.sessionRefJson, v.polls, v.turnEnded],
  );
}

export async function deleteSessionProgress(db: Db, agentRunId: string): Promise<void> {
  await db.query("delete from agent_session_progress where agent_run_id = $1", [agentRunId]);
}
