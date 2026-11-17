
import type { Queryable } from "../db/transaction.js";

export interface AgentRun {
  id: string;
  engineeringRunId: string;
  workerType: string;
  model: string;
  role: "planner" | "implementer" | "debugger" | "reviewer" | "repairer";
  startedAt: Date | null;
  completedAt: Date | null;
  result: unknown;
  tokenUsage: unknown;
  modelCost: number | null;
}

export type NewAgentRun = Omit<AgentRun, "id" | "startedAt" | "completedAt" | "result" | "modelCost"> &
  Partial<Pick<AgentRun, "result" | "modelCost">>;

function rowToAgentRun(row: Record<string, unknown>): AgentRun {
  return {
    id: row.id as string,
    engineeringRunId: row.engineering_run_id as string,
    workerType: row.worker_type as string,
    model: row.model as string,
    role: row.role as AgentRun["role"],
    startedAt: row.started_at as Date | null,
    completedAt: row.completed_at as Date | null,
    result: row.result,
    tokenUsage: row.token_usage,
    modelCost: row.model_cost === null ? null : Number(row.model_cost),
  };
}

export async function insertAgentRun(db: Queryable, run: NewAgentRun): Promise<AgentRun> {
  const { rows } = await db.query(
    `insert into agent_run (engineering_run_id, worker_type, model, role, token_usage)
     values ($1, $2, $3, $4, $5)
     returning *`,
    [run.engineeringRunId, run.workerType, run.model, run.role, JSON.stringify(run.tokenUsage ?? null)],
  );
  return rowToAgentRun(rows[0]);
}

export async function getAgentRun(db: Queryable, id: string): Promise<AgentRun | null> {
  const { rows } = await db.query("select * from agent_run where id = $1", [id]);
  return rows[0] ? rowToAgentRun(rows[0]) : null;
}

export interface AgentRunPatch {
  startedAt?: Date | null;
  completedAt?: Date | null;
  result?: unknown;
  tokenUsage?: unknown;
  modelCost?: number | null;
}

const AGENT_RUN_PATCH_COLUMNS: Record<keyof AgentRunPatch, string> = {
  startedAt: "started_at",
  completedAt: "completed_at",
  result: "result",
  tokenUsage: "token_usage",
  modelCost: "model_cost",
};

export async function updateAgentRun(
  db: Queryable,
  id: string,
  patch: AgentRunPatch,
): Promise<AgentRun> {
  const entries = Object.entries(patch) as Array<[keyof AgentRunPatch, unknown]>;
  if (entries.length === 0) {
    const current = await getAgentRun(db, id);
    if (!current) throw new Error(`agent_run ${id} not found`);
    return current;
  }
  const setClauses = entries.map(([key], i) => `${AGENT_RUN_PATCH_COLUMNS[key]} = $${i + 2}`);
  const values = entries.map(([key, value]) =>
    key === "result" || key === "tokenUsage" ? JSON.stringify(value ?? null) : value,
  );
  const { rows } = await db.query(
    `update agent_run set ${setClauses.join(", ")} where id = $1 returning *`,
    [id, ...values],
  );
  if (!rows[0]) throw new Error(`agent_run ${id} not found`);
  return rowToAgentRun(rows[0]);
}

export async function listAgentRuns(db: Queryable, engineeringRunId: string): Promise<AgentRun[]> {
  const { rows } = await db.query(
    "select * from agent_run where engineering_run_id = $1 order by started_at nulls last, id",
    [engineeringRunId],
  );
  return rows.map(rowToAgentRun);
}
