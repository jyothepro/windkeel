
import type { Queryable } from "../db/transaction.js";

type Row = Record<string, unknown>;

export async function selectMakerScreenshotShas(db: Queryable, engineeringRunId: string): Promise<string[]> {
  const { rows } = await db.query("select sha256 from maker_screenshot where engineering_run_id = $1", [engineeringRunId]);
  return rows.map((r) => r.sha256 as string);
}

export interface MakerScreenshotInsert {
  engineeringRunId: string;
  agentRunId: string;
  sha256: string;
  objectKey: string;
  bytes: number;
  name: string;
  url: string | null;
  pageTitle: string | null;

  consoleErrors: string;
}

export async function insertMakerScreenshotRow(db: Queryable, v: MakerScreenshotInsert): Promise<string | undefined> {
  const inserted = await db.query(
    `insert into maker_screenshot
       (engineering_run_id, agent_run_id, sha256, object_key, bytes, name, url, page_title, console_errors)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     on conflict (engineering_run_id, sha256) do nothing
     returning id`,
    [v.engineeringRunId, v.agentRunId, v.sha256, v.objectKey, v.bytes, v.name, v.url, v.pageTitle, v.consoleErrors],
  );
  return inserted.rows[0]?.id as string | undefined;
}

export async function insertScreenshotAgentEvent(
  db: Queryable,
  engineeringRunId: string,
  agentRunId: string,
  payload: string,
): Promise<void> {
  await db.query(
    `insert into agent_event (engineering_run_id, agent_run_id, ordinal, type, payload)
     values ($1, $2, null, 'screenshot', $3::jsonb)`,
    [engineeringRunId, agentRunId, payload],
  );
}

export async function selectMakerScreenshotRows(db: Queryable, engineeringRunId: string): Promise<Row[]> {
  const { rows } = await db.query(
    "select * from maker_screenshot where engineering_run_id = $1 order by seq asc",
    [engineeringRunId],
  );
  return rows;
}

export async function selectMakerScreenshotRow(db: Queryable, engineeringRunId: string, screenshotId: string): Promise<Row | undefined> {
  const { rows } = await db.query("select * from maker_screenshot where engineering_run_id = $1 and id = $2", [
    engineeringRunId,
    screenshotId,
  ]);
  return rows[0];
}

export async function selectExpiredScreenshotRuns(db: Queryable, now: Date, retentionDays: number): Promise<Row[]> {
  const { rows } = await db.query(
    `select engineering_run_id, max(captured_at) as newest, count(*)::int as count
       from maker_screenshot
      group by engineering_run_id
     having max(captured_at) <= $1::timestamptz - ($2::int * interval '1 day')
      order by newest, engineering_run_id`,
    [now, retentionDays],
  );
  return rows;
}

export async function deleteMakerScreenshotsUpTo(db: Queryable, engineeringRunId: string, newestCapturedAt: Date): Promise<number> {
  const { rowCount } = await db.query(
    `delete from maker_screenshot
      where engineering_run_id = $1
        and date_trunc('milliseconds', captured_at) <= $2`,
    [engineeringRunId, newestCapturedAt],
  );
  return rowCount ?? 0;
}
