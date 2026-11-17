import type { Pool } from "pg";
import type { Log } from "../stage-wiring.js";
import { withSweepLock, type LockOutcome } from "./advisory-lock.js";
import { selectStrandedCreatedRuns } from "./stores/run-sweep-store.js";

const STRANDED_CREATED_RUNS_SWEEP = "stranded-created-runs";

export const DEFAULT_MINIMUM_CREATED_AGE_MS = 10 * 60 * 1000;
const DEFAULT_MAXIMUM_CREATED_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_STRANDED_BATCH = 50;

export interface StrandedCreatedRunsDeps {
  pool: Pool;
  startRun(engineeringRunId: string): Promise<{ enqueued: boolean }>;
  minimumAgeMs?: number;
  maximumAgeMs?: number;
  batch?: number;
  log?: Log;
}

export interface StrandedCreatedRunsResult {
  examined: number;
  requeued: number;
  skipped: number;
  failed: number;
}

export async function requeueStrandedCreatedRuns(
  deps: StrandedCreatedRunsDeps,
): Promise<StrandedCreatedRunsResult> {
  const log = deps.log ?? (() => {});
  const rows = await selectStrandedCreatedRuns(
    deps.pool,
    deps.minimumAgeMs ?? DEFAULT_MINIMUM_CREATED_AGE_MS,
    deps.maximumAgeMs ?? DEFAULT_MAXIMUM_CREATED_AGE_MS,
    deps.batch ?? DEFAULT_STRANDED_BATCH,
  );

  const result: StrandedCreatedRunsResult = { examined: rows.length, requeued: 0, skipped: 0, failed: 0 };
  for (const row of rows) {
    try {
      const { enqueued } = await deps.startRun(row.id);
      if (enqueued) {
        result.requeued += 1;
        log("re-enqueued a run stranded in CREATED", {
          engineeringRunId: row.id,
          sourceType: row.source_type,
          createdAt: row.created_at.toISOString(),
        });
      } else {
        result.skipped += 1;
      }
    } catch (error) {
      result.failed += 1;
      log("could not re-enqueue a run stranded in CREATED", {
        engineeringRunId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

export async function requeueStrandedCreatedRunsLocked(
  deps: StrandedCreatedRunsDeps,
): Promise<LockOutcome<StrandedCreatedRunsResult>> {
  return withSweepLock(deps.pool, STRANDED_CREATED_RUNS_SWEEP, () => requeueStrandedCreatedRuns(deps));
}
