import type { Pool, PoolClient } from "pg";
import type { EvidenceStorage } from "./evidence-storage.js";
import { makerScreenshotPrefix } from "./maker-screenshots.js";
import { deleteMakerScreenshotsUpTo, selectExpiredScreenshotRuns } from "./stores/maker-screenshot-store.js";

type Queryable = Pool | PoolClient;

export const MAKER_SCREENSHOT_RETENTION_DAYS = 30;

export interface PrunableScreenshotRun {
  engineeringRunId: string;
  newestCapturedAt: Date;
  count: number;
}

export async function listPrunableScreenshotRuns(
  db: Queryable,
  now: Date,
  retentionDays: number,
): Promise<PrunableScreenshotRun[]> {
  const rows = await selectExpiredScreenshotRuns(db, now, retentionDays);
  return rows.map((row) => ({
    engineeringRunId: row["engineering_run_id"] as string,
    newestCapturedAt: row["newest"] as Date,
    count: Number(row["count"]),
  }));
}

export async function pruneScreenshotRun(
  pool: Pool,
  storage: EvidenceStorage,
  bucket: string,
  run: PrunableScreenshotRun,
): Promise<number> {
  await storage.deletePackage(bucket, makerScreenshotPrefix(run.engineeringRunId));
  return deleteMakerScreenshotsUpTo(pool, run.engineeringRunId, run.newestCapturedAt);
}

export interface ScreenshotRetentionSweepResult {
  prunedRunIds: string[];
  screenshotsPruned: number;
  interrupted: boolean;
}

export async function runScreenshotRetentionSweep(
  pool: Pool,
  storage: EvidenceStorage,
  bucket: string,
  now: Date = new Date(),
  retentionDays: number = MAKER_SCREENSHOT_RETENTION_DAYS,
  options: { signal?: AbortSignal } = {},
): Promise<ScreenshotRetentionSweepResult> {
  const candidates = await listPrunableScreenshotRuns(pool, now, retentionDays);
  const prunedRunIds: string[] = [];
  let screenshotsPruned = 0;
  for (const run of candidates) {
    if (options.signal?.aborted) return { prunedRunIds, screenshotsPruned, interrupted: true };
    const removed = await pruneScreenshotRun(pool, storage, bucket, run);
    if (removed > 0) {
      prunedRunIds.push(run.engineeringRunId);
      screenshotsPruned += removed;
    }
  }
  return { prunedRunIds, screenshotsPruned, interrupted: false };
}
