import type { Pool, PoolClient } from "pg";

type Db = Pool | PoolClient;

export async function firstRunOfTask(db: Db, taskId: string): Promise<{ id: string; status: string } | undefined> {
  const { rows } = await db.query<{ id: string; status: string }>(
    "select id, status from engineering_run where task_id = $1 order by created_at asc, id asc limit 1",
    [taskId],
  );
  return rows[0];
}

export async function lockRunStatus(client: PoolClient, runId: string): Promise<string | undefined> {
  const locked = await client.query("select status from engineering_run where id = $1 for update", [runId]);
  return locked.rows[0]?.["status"] as string | undefined;
}

export async function runFeedHead(db: Db, runId: string): Promise<unknown> {
  const { rows } = await db.query(
    `select coalesce(max(seq), 0) as head from (
       select seq from run_state_transition where engineering_run_id = $1
       union all
       select seq from cost_event where engineering_run_id = $1
     ) feed`,
    [runId],
  );
  return rows[0]?.["head"];
}
