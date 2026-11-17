import type { Pool } from "pg";
import type { RunState } from "../run-state-machine.js";
import type { Log } from "../stage-wiring.js";
import { withSweepLock, type LockOutcome } from "./advisory-lock.js";
import { selectStalledBindings } from "./stores/run-sweep-store.js";

const STALLED_RUNS_SWEEP = "stalled-runs";

const STEP_CEILING_MS = 800_000;
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const STALLED_AFTER_POLL_TICKS = 30;
export const DEFAULT_MAX_RECLAIMS = 3;
const DEFAULT_STALLED_BATCH = 25;

export function stalledAfterMs(pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS): number {
  return Math.max(STALLED_AFTER_POLL_TICKS * pollIntervalMs, 2 * (STEP_CEILING_MS + pollIntervalMs));
}

export type StalledRunReclaim =
  | { kind: "redispatched"; state: RunState; reclaims: number }
  | { kind: "failed"; state: RunState; reason: string }
  | { kind: "released"; state: RunState }
  | { kind: "skipped"; why: string };

export interface StalledRunsDeps {
  pool: Pool;
  reclaim(
    engineeringRunId: string,
    options: { stalledForMs: number; maxReclaims: number },
  ): Promise<StalledRunReclaim>;
  pollIntervalMs?: number;
  stalledForMs?: number;
  maxReclaims?: number;
  batch?: number;
  log?: Log;
}

export interface StalledRunsResult {
  examined: number;
  redispatched: number;
  failedRuns: number;
  released: number;
  skipped: number;
  errors: number;
}

export async function reclaimStalledRuns(deps: StalledRunsDeps): Promise<StalledRunsResult> {
  const log = deps.log ?? (() => {});
  const stalledForMs = deps.stalledForMs ?? stalledAfterMs(deps.pollIntervalMs);
  const maxReclaims = deps.maxReclaims ?? DEFAULT_MAX_RECLAIMS;
  const rows = await selectStalledBindings(deps.pool, stalledForMs, deps.batch ?? DEFAULT_STALLED_BATCH);

  const result: StalledRunsResult = {
    examined: rows.length,
    redispatched: 0,
    failedRuns: 0,
    released: 0,
    skipped: 0,
    errors: 0,
  };
  for (const row of rows) {
    try {
      const outcome = await deps.reclaim(row.id, { stalledForMs, maxReclaims });
      if (outcome.kind === "redispatched") result.redispatched += 1;
      else if (outcome.kind === "failed") result.failedRuns += 1;
      else if (outcome.kind === "released") result.released += 1;
      else result.skipped += 1;
      if (outcome.kind !== "skipped") {
        log("stalled run", {
          engineeringRunId: row.id,
          outcome: outcome.kind,
          state: row.status,
          phase: row.phase,
          lastProgressAt: row.updated_at.toISOString(),
        });
      }
    } catch (error) {
      result.errors += 1;
      log("could not reclaim a stalled run", {
        engineeringRunId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

export async function reclaimStalledRunsLocked(
  deps: StalledRunsDeps,
): Promise<LockOutcome<StalledRunsResult>> {
  return withSweepLock(deps.pool, STALLED_RUNS_SWEEP, () => reclaimStalledRuns(deps));
}
