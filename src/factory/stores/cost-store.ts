
import type { Queryable } from "../db/transaction.js";

export interface CostEventRowValues {
  engineeringRunId: string;
  stageType: string;
  stageId: string;
  kind: string;
  tokensIn: number | null;
  tokensOut: number | null;
  usd: number | null;
  keySource: string | null;
  credentialId: string | null;
  model: string | null;
  sandboxMs: number | null;
}

export async function insertCostEventRow(db: Queryable, v: CostEventRowValues): Promise<Record<string, unknown>> {
  const { rows } = await db.query(
    `insert into cost_event
       (engineering_run_id, stage_type, stage_id, kind, tokens_in, tokens_out, usd,
        key_source, credential_id, model, sandbox_ms)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning *`,
    [
      v.engineeringRunId,
      v.stageType,
      v.stageId,
      v.kind,
      v.tokensIn,
      v.tokensOut,
      v.usd,
      v.keySource,
      v.credentialId,
      v.model,
      v.sandboxMs,
    ],
  );
  return rows[0];
}

export async function incrementEngineeringRunCost(db: Queryable, engineeringRunId: string, usd: number): Promise<void> {
  await db.query("update engineering_run set cost = cost + $1 where id = $2", [usd, engineeringRunId]);
}

export async function selectCostEventTotal(db: Queryable, engineeringRunId: string): Promise<unknown> {
  const { rows } = await db.query(
    "select coalesce(sum(usd), 0) as total from cost_event where engineering_run_id = $1",
    [engineeringRunId],
  );
  return rows[0].total;
}

export async function selectWorkspaceCharged(
  db: Queryable,
  engineeringRunId: string,
  workspaceId: string,
): Promise<{ charged: unknown; charged_ms: unknown }> {
  const { rows } = await db.query(
    `select coalesce(sum(usd), 0) as charged, coalesce(sum(sandbox_ms), 0) as charged_ms from cost_event
     where engineering_run_id = $1 and stage_type = 'workspace' and stage_id = $2`,
    [engineeringRunId, workspaceId],
  );
  return rows[0];
}

export async function selectUnpricedModelUsage(db: Queryable, engineeringRunId: string): Promise<Record<string, unknown>[]> {
  const { rows } = await db.query(
    `select model,
            coalesce(sum(tokens_in), 0) as tokens_in,
            coalesce(sum(tokens_out), 0) as tokens_out
       from cost_event
      where engineering_run_id = $1 and kind = 'model' and usd is null
      group by model
      order by model nulls last`,
    [engineeringRunId],
  );
  return rows;
}

export async function selectRunCostTotals(db: Queryable, engineeringRunId: string): Promise<Record<string, unknown>> {
  const { rows } = await db.query(
    `select
       coalesce(sum(usd), 0) as total,
       coalesce(sum(usd) filter (where kind = 'model'), 0) as model,
       coalesce(sum(usd) filter (where kind = 'sandbox'), 0) as sandbox,
       count(*) filter (where kind = 'model' and usd is null)::int as unpriced
     from cost_event where engineering_run_id = $1`,
    [engineeringRunId],
  );
  return rows[0];
}

export async function selectRunModelCostBySource(db: Queryable, engineeringRunId: string): Promise<Record<string, unknown>[]> {
  const { rows } = await db.query(
    `select key_source,
            coalesce(sum(usd), 0) as usd,
            count(*)::int as calls,
            count(*) filter (where usd is null)::int as unpriced,
            sum(tokens_in) as tokens_in,
            sum(tokens_out) as tokens_out
       from cost_event
      where engineering_run_id = $1 and kind = 'model'
      group by key_source
      order by case key_source when 'orqon' then 0 when 'customer' then 1 else 2 end`,
    [engineeringRunId],
  );
  return rows;
}
