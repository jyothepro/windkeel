import type { Pool } from "pg";
import {
  getEngineeringRunForUpdate,
  getLastTransitionInto,
  insertRunStateTransition,
  updateEngineeringRun,
  type EngineeringRun,
  type RunStateTransitionRow,
} from "./repositories.js";
import type { StopReason } from "./rails.js";
import { TERMINAL_STATES, transition, type RunState } from "./run-state-machine.js";
import { expireMissedTakeover } from "./human-session.js";
import { withTransaction } from "./db/transaction.js";

export type RunOutcomeListener = (
  pool: Pool,
  run: EngineeringRun,
  transition: RunStateTransitionRow,
) => Promise<void>;

let runOutcomeListener: RunOutcomeListener | null = null;

export function setRunOutcomeListener(listener: RunOutcomeListener | null): RunOutcomeListener | null {
  const previous = runOutcomeListener;
  runOutcomeListener = listener;
  return previous;
}

export class RunNotFoundError extends Error {
  constructor(id: string) {
    super(`engineering_run ${id} not found`);
    this.name = "RunNotFoundError";
  }
}

export interface AdvanceRunResult {
  run: EngineeringRun;
  transition: RunStateTransitionRow;
}

export async function advanceRun(
  pool: Pool,
  engineeringRunId: string,
  to: RunState,
  reason: string | null = null,
  extra: { stopReason?: StopReason | null } = {},
): Promise<AdvanceRunResult> {
  const committed = await withTransaction(pool, async (client): Promise<AdvanceRunResult> => {
    const run = await getEngineeringRunForUpdate(client, engineeringRunId);
    if (!run) throw new RunNotFoundError(engineeringRunId);

    const replay =
      run.status === to ? await getLastTransitionInto(client, engineeringRunId, to) : null;
    if (replay && replay.reason === reason) {

      return { run, transition: replay };
    } else {
      let blockedFrom: RunState | null = null;
      if (run.status === "BLOCKED") {
        const last = await getLastTransitionInto(client, engineeringRunId, "BLOCKED");
        blockedFrom = last?.fromState ?? null;
      }

      const { record } = transition({ state: run.status, blockedFrom }, to, reason);

      if ((run.status === "IMPLEMENTING" || run.status === "REPAIRING") && to !== "HUMAN_EDITING") {
        await expireMissedTakeover(client, engineeringRunId);
      }

      const now = new Date();
      const updated = await updateEngineeringRun(client, engineeringRunId, {
        status: to,
        ...(run.status === "CREATED" && run.startedAt === null ? { startedAt: now } : {}),
        ...(TERMINAL_STATES.has(to) ? { completedAt: now } : {}),
        ...(extra.stopReason !== undefined ? { stopReason: extra.stopReason } : {}),
      });
      const transitionRow = await insertRunStateTransition(client, {
        engineeringRunId,
        fromState: record.from,
        toState: record.to,
        reason: record.reason,
      });

      return { run: updated, transition: transitionRow };
    }
  });

  if (runOutcomeListener) await runOutcomeListener(pool, committed.run, committed.transition);
  return committed;
}
