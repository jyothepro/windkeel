import type { Pool } from "pg";
import { registerSourceNotifier, type SourceNotifier } from "../intake/notifiers.js";
import type { IntakeLog } from "../factory/log.js";
import { BATCH_SOURCE_TYPE, dispatchOrganization, type DispatchDeps } from "./dispatch.js";

export function createBatchNotifier(pool: Pool, deps: DispatchDeps): SourceNotifier {
  return {
    sourceType: BATCH_SOURCE_TYPE,
    async notify(task, _run, outcome) {
      if (outcome.kind !== "state") return;
      if (!outcome.terminal && outcome.state !== "WAITING_FOR_HUMAN") return;
      await dispatchOrganization(pool, task.organizationId, deps);
    },
  };
}

export function registerBatchNotifier(
  pool: Pool,
  startRun: (engineeringRunId: string) => Promise<{ enqueued: boolean }>,
  log?: IntakeLog,
): void {
  registerSourceNotifier(createBatchNotifier(pool, { startRun, ...(log ? { log } : {}) }));
}
