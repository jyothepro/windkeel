import type { Pool } from "pg";
import type { Log } from "../stage-wiring.js";
import { withSweepLock, type LockOutcome } from "./advisory-lock.js";
import { selectRunsWithStaleSignals } from "./stores/run-sweep-store.js";

const SIGNAL_RECOVERY_SWEEP = "signal-recovery";

export interface SignalRecoveryDeps {
  pool: Pool;

  recoverStranded(engineeringRunId: string): Promise<boolean>;

  minimumAgeMs?: number;
  log?: Log;
}

export interface SignalRecoveryResult {

  examined: number;

  recovered: number;

  skipped: number;

  failed: number;
}

export const DEFAULT_MINIMUM_SIGNAL_AGE_MS = 10 * 60 * 1000;

export async function recoverStrandedSignals(
  deps: SignalRecoveryDeps,
): Promise<SignalRecoveryResult> {
  const log = deps.log ?? (() => {});
  const minimumAgeMs = deps.minimumAgeMs ?? DEFAULT_MINIMUM_SIGNAL_AGE_MS;

  const rows = await selectRunsWithStaleSignals(deps.pool, minimumAgeMs);

  const result: SignalRecoveryResult = {
    examined: rows.length,
    recovered: 0,
    skipped: 0,
    failed: 0,
  };

  for (const row of rows) {
    try {
      if (await deps.recoverStranded(row.engineering_run_id)) {
        result.recovered += 1;
        log("restarted a run whose signal nothing was carrying", {
          engineeringRunId: row.engineering_run_id,
          waitingSignals: Number(row.waiting),
        });
      } else {

        result.skipped += 1;
      }
    } catch (error) {

      result.failed += 1;
      log("could not restart a run whose signal nothing was carrying", {
        engineeringRunId: row.engineering_run_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

export async function recoverStrandedSignalsLocked(
  deps: SignalRecoveryDeps,
): Promise<LockOutcome<SignalRecoveryResult>> {
  return withSweepLock(deps.pool, SIGNAL_RECOVERY_SWEEP, () => recoverStrandedSignals(deps));
}
