
import type { PoolClient } from "pg";
import type { Verdict } from "@windkeel/verification/evidence/format.js";
import type { StopReason } from "../rails.js";
import type { RunState } from "../run-state-machine.js";
import type { RunModelConfig, TaskModelOverride } from "../model-policy.js";
import type { Queryable } from "../db/transaction.js";

export interface EngineeringRun {
  id: string;

  createdAt: Date;
  taskId: string;
  status: RunState;
  plan: unknown;
  selectedWorker: string | null;
  selectedModel: string | null;
  sandboxProvider: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cost: number;
  finalVerdict: Verdict | null;
  spendCapUsd: number | null;
  wallClockCapSeconds: number;
  stopReason: StopReason | null;
  prNumber: number | null;
  prMergedAt: Date | null;

  humanCommitsAfterPr: number | null;

  modelConfig: RunModelConfig | null;

  modelOverride: TaskModelOverride | null;
}

export type NewEngineeringRun = Pick<
  EngineeringRun,
  "taskId" | "spendCapUsd" | "wallClockCapSeconds"
> &
  Partial<Pick<EngineeringRun, "selectedWorker" | "selectedModel" | "sandboxProvider" | "modelOverride">>;

function rowToRun(row: Record<string, unknown>): EngineeringRun {
  return {
    id: row.id as string,
    createdAt: row.created_at as Date,
    taskId: row.task_id as string,
    status: row.status as RunState,
    plan: row.plan,
    selectedWorker: row.selected_worker as string | null,
    selectedModel: row.selected_model as string | null,
    sandboxProvider: row.sandbox_provider as string | null,
    startedAt: row.started_at as Date | null,
    completedAt: row.completed_at as Date | null,
    cost: Number(row.cost),
    finalVerdict: row.final_verdict as Verdict | null,
    spendCapUsd: row.spend_cap_usd === null ? null : Number(row.spend_cap_usd),
    wallClockCapSeconds: row.wall_clock_cap_seconds as number,
    stopReason: row.stop_reason as StopReason | null,
    prNumber: row.pr_number as number | null,
    prMergedAt: row.pr_merged_at as Date | null,
    humanCommitsAfterPr: row.human_commits_after_pr as number | null,
    modelConfig: (row.model_config as RunModelConfig | null | undefined) ?? null,
    modelOverride: (row.model_override as TaskModelOverride | null | undefined) ?? null,
  };
}

export async function insertEngineeringRun(
  db: Queryable,
  run: NewEngineeringRun,
): Promise<EngineeringRun> {

  const override = run.modelOverride ? JSON.stringify(run.modelOverride) : null;
  const { rows } = await db.query(
    `insert into engineering_run
       (task_id, status, selected_worker, selected_model, sandbox_provider,
        cost, spend_cap_usd, wall_clock_cap_seconds${override ? ", model_override" : ""})
     values ($1, 'CREATED', $2, $3, $4, 0, $5, $6${override ? ", $7" : ""})
     returning *`,
    [
      run.taskId,
      run.selectedWorker ?? null,
      run.selectedModel ?? null,
      run.sandboxProvider ?? null,
      run.spendCapUsd,
      run.wallClockCapSeconds,
      ...(override ? [override] : []),
    ],
  );
  return rowToRun(rows[0]);
}

export async function getEngineeringRun(db: Queryable, id: string): Promise<EngineeringRun | null> {
  const { rows } = await db.query("select * from engineering_run where id = $1", [id]);
  return rows[0] ? rowToRun(rows[0]) : null;
}

export async function listEngineeringRuns(
  db: Queryable,
  taskId: string,
): Promise<EngineeringRun[]> {
  const { rows } = await db.query(

    "select * from engineering_run where task_id = $1 order by created_at desc, id desc",
    [taskId],
  );
  return rows.map(rowToRun);
}

export async function getEngineeringRunForUpdate(
  client: PoolClient,
  id: string,
): Promise<EngineeringRun | null> {
  const { rows } = await client.query("select * from engineering_run where id = $1 for update", [id]);
  return rows[0] ? rowToRun(rows[0]) : null;
}

export interface EngineeringRunPatch {
  status?: RunState;
  startedAt?: Date | null;
  completedAt?: Date | null;
  finalVerdict?: Verdict | null;
  stopReason?: StopReason | null;
  plan?: unknown;
  prNumber?: number | null;
  prMergedAt?: Date | null;
  humanCommitsAfterPr?: number | null;
  modelConfig?: RunModelConfig | null;
  selectedModel?: string | null;
  selectedWorker?: string | null;
}

const PATCH_COLUMNS: Record<keyof EngineeringRunPatch, string> = {
  status: "status",
  startedAt: "started_at",
  completedAt: "completed_at",
  finalVerdict: "final_verdict",
  stopReason: "stop_reason",
  plan: "plan",
  prNumber: "pr_number",
  prMergedAt: "pr_merged_at",
  humanCommitsAfterPr: "human_commits_after_pr",
  modelConfig: "model_config",
  selectedModel: "selected_model",
  selectedWorker: "selected_worker",
};

export async function updateEngineeringRun(
  db: Queryable,
  id: string,
  patch: EngineeringRunPatch,
): Promise<EngineeringRun> {
  const entries = Object.entries(patch) as Array<[keyof EngineeringRunPatch, unknown]>;
  if (entries.length === 0) {
    const current = await getEngineeringRun(db, id);
    if (!current) throw new Error(`engineering_run ${id} not found`);
    return current;
  }
  const setClauses = entries.map(([key], i) => `${PATCH_COLUMNS[key]} = $${i + 2}`);
  const values = entries.map(([key, value]) =>
    key === "plan" || (key === "modelConfig" && value !== null) ? JSON.stringify(value) : value,
  );
  const { rows } = await db.query(
    `update engineering_run set ${setClauses.join(", ")} where id = $1 returning *`,
    [id, ...values],
  );
  if (!rows[0]) throw new Error(`engineering_run ${id} not found`);
  return rowToRun(rows[0]);
}

export async function listPendingSignals(
  db: Queryable,
  engineeringRunId: string,
): Promise<{ id: string; kind: string; receivedAt: Date }[]> {
  const { rows } = await db.query(
    `select id, kind, received_at from run_signal
      where engineering_run_id = $1 and consumed_at is null
      order by received_at asc, id asc`,
    [engineeringRunId],
  );
  return rows.map((row) => ({
    id: row.id as string,
    kind: row.kind as string,
    receivedAt: row.received_at as Date,
  }));
}

export interface RunStateTransitionRow {
  id: string;

  seq: string;
  engineeringRunId: string;
  fromState: RunState | null;
  toState: RunState;
  reason: string | null;
  at: Date;
}

function rowToTransition(row: Record<string, unknown>): RunStateTransitionRow {
  return {
    id: row.id as string,
    seq: String(row.seq),
    engineeringRunId: row.engineering_run_id as string,
    fromState: row.from_state as RunState | null,
    toState: row.to_state as RunState,
    reason: row.reason as string | null,
    at: row.at as Date,
  };
}

export async function insertRunStateTransition(
  db: Queryable,
  transition: { engineeringRunId: string; fromState: RunState | null; toState: RunState; reason: string | null },
): Promise<RunStateTransitionRow> {
  const { rows } = await db.query(
    `insert into run_state_transition (engineering_run_id, from_state, to_state, reason)
     values ($1, $2, $3, $4)
     returning *`,
    [transition.engineeringRunId, transition.fromState, transition.toState, transition.reason],
  );
  return rowToTransition(rows[0]);
}

export async function listRunStateTransitions(
  db: Queryable,
  engineeringRunId: string,
): Promise<RunStateTransitionRow[]> {
  const { rows } = await db.query(
    `select * from run_state_transition
     where engineering_run_id = $1
     order by at asc, id asc`,
    [engineeringRunId],
  );
  return rows.map(rowToTransition);
}

export async function getLastTransitionInto(
  db: Queryable,
  engineeringRunId: string,
  toState: RunState,
): Promise<RunStateTransitionRow | null> {
  const { rows } = await db.query(
    `select * from run_state_transition
     where engineering_run_id = $1 and to_state = $2
     order by at desc, id desc
     limit 1`,
    [engineeringRunId, toState],
  );
  return rows[0] ? rowToTransition(rows[0]) : null;
}

export async function selectRunRowForPullRequest(
  db: Queryable,
  repositoryId: string,
  pullNumber: number,
): Promise<Record<string, unknown> | undefined> {
  const { rows } = await db.query(
    `select r.* from engineering_run r
       join engineering_task t on t.id = r.task_id
      where t.repository_id = $1 and r.pr_number = $2
      order by r.started_at desc nulls last
      limit 1`,
    [repositoryId, pullNumber],
  );
  return rows[0];
}

export async function selectRunSnapshot(
  db: Queryable,
  runId: string,
): Promise<{ status: string; marker: string | null } | undefined> {
  const { rows } = await db.query(
    `select r.status,
            (select max(t.seq) from run_state_transition t where t.engineering_run_id = r.id)::text as marker
       from engineering_run r
      where r.id = $1`,
    [runId],
  );
  return rows[0] as { status: string; marker: string | null } | undefined;
}

export async function lockEngineeringRunRow(db: Queryable, engineeringRunId: string): Promise<void> {
  await db.query("select id from engineering_run where id = $1 for update", [engineeringRunId]);
}

export async function selectRunOrganizationId(db: Queryable, engineeringRunId: string): Promise<string | undefined> {
  const { rows } = await db.query(
    `select t.organization_id from engineering_run r join engineering_task t on t.id = r.task_id where r.id = $1`,
    [engineeringRunId],
  );
  return rows[0]?.["organization_id"] as string | undefined;
}
