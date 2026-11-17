import type { Pool, PoolClient } from "pg";
import type { Criterion } from "@windkeel/verification/evidence/format.js";
import type { RiskLevel } from "../factory/rails.js";
import {
  listEngineeringRuns,
  updateEngineeringTask,
  type EngineeringRun,
  type EngineeringTask,
} from "../factory/repositories.js";
import { TERMINAL_STATES } from "../factory/run-state-machine.js";
import { startNewRun, type RailsOptions } from "../billing/admitted-runs.js";
import { setTaskSourceContext } from "./stores/intake-store.js";

type Queryable = Pool | PoolClient;

export type RetriggerKind = "re-enqueue" | "already_tasked" | "rerun";

export interface RetriggerResult {
  kind: RetriggerKind;
  taskId: string;
  run: EngineeringRun;
}

export interface RetriggerInput {
  title: string;
  description: string;
  criteria: Criterion[];
  riskLevel?: RiskLevel;
  sourceContext?: Record<string, unknown>;
  rails?: RailsOptions;
}

export function retriggerDecision(
  runs: readonly EngineeringRun[],
): { kind: "re-enqueue" | "already_tasked"; run: EngineeringRun } | { kind: "rerun" } {
  const live = runs.find((run) => !TERMINAL_STATES.has(run.status));
  if (!live) return { kind: "rerun" };
  return { kind: live.status === "CREATED" ? "re-enqueue" : "already_tasked", run: live };
}

export async function retriggerExistingTask(
  db: Queryable,
  existing: Pick<EngineeringTask, "id" | "riskLevel">,
  input: RetriggerInput,
): Promise<RetriggerResult> {
  const decision = retriggerDecision(await listEngineeringRuns(db, existing.id));
  if (decision.kind === "already_tasked") return { kind: "already_tasked", taskId: existing.id, run: decision.run };

  if (input.sourceContext !== undefined) {
    await setTaskSourceContext(db, existing.id, JSON.stringify(input.sourceContext));
  }
  if (decision.kind === "re-enqueue") return { kind: "re-enqueue", taskId: existing.id, run: decision.run };

  await updateEngineeringTask(db, existing.id, {
    title: input.title,
    description: input.description,
    acceptanceCriteria: input.criteria,
    criteriaProvenance: "extracted",
    criteriaGeneratedBy: null,
    criteriaApprovedAt: null,
    criteriaApprovedBy: null,
    riskLevel: input.riskLevel ?? existing.riskLevel,
    status: "OPEN",
  });
  const run = await startNewRun(db, existing.id, input.rails ?? {});
  return { kind: "rerun", taskId: existing.id, run };
}
