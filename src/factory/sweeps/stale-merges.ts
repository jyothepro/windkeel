import type { Pool } from "pg";
import type { Log } from "../stage-wiring.js";
import { withSweepLock, type LockOutcome } from "./advisory-lock.js";
import { failStaleMerges } from "./stores/run-sweep-store.js";

const STALE_MERGES_SWEEP = "stale-run-merges";

export const DEFAULT_STALE_MERGE_AGE_MS = 15 * 60 * 1000;
const DEFAULT_STALE_MERGE_BATCH = 100;

export const STALE_MERGE_REASON =
  "the merge didn't finish — Windkeel lost track of it after 15 minutes. Check the pull request on GitHub before merging again";

export interface StaleMergesDeps {
  pool: Pool;
  maximumAgeMs?: number;
  batch?: number;
  log?: Log;
}

export interface StaleMergesResult {
  settled: string[];
}

export async function settleStaleMerges(deps: StaleMergesDeps): Promise<StaleMergesResult> {
  const log = deps.log ?? (() => {});
  const ageMs = deps.maximumAgeMs ?? DEFAULT_STALE_MERGE_AGE_MS;
  const minutes = Math.round(ageMs / 60_000);
  const reason = ageMs === DEFAULT_STALE_MERGE_AGE_MS ? STALE_MERGE_REASON : STALE_MERGE_REASON.replace("15 minutes", `${minutes} minute${minutes === 1 ? "" : "s"}`);
  const rows = await failStaleMerges(deps.pool, ageMs, deps.batch ?? DEFAULT_STALE_MERGE_BATCH, reason);
  for (const row of rows) {
    log("settled a stale merge as failed", { runMergeId: row.id, engineeringRunId: row.engineering_run_id });
  }
  return { settled: rows.map((r) => r.id) };
}

export async function settleStaleMergesLocked(deps: StaleMergesDeps): Promise<LockOutcome<StaleMergesResult>> {
  return withSweepLock(deps.pool, STALE_MERGES_SWEEP, () => settleStaleMerges(deps));
}
