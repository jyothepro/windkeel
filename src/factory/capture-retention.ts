import type { Pool, PoolClient } from "pg";
import type { EvidenceStorage } from "./evidence-storage.js";
import { markRunCapturePruned, selectPrunableCaptureRows, selectRunCaptureRow, upsertRunCaptureRow } from "./stores/capture-store.js";

type Queryable = Pool | PoolClient;

export const CAPTURE_RETENTION_DAYS = 30;

export interface RunCapture {
  engineeringRunId: string;
  bucket: string;
  objectKey: string;
  byteTotal: number;
  capturedAt: Date;
  prunedAt: Date | null;
}

function rowToRunCapture(row: Record<string, unknown>): RunCapture {
  return {
    engineeringRunId: row["engineering_run_id"] as string,
    bucket: row["bucket"] as string,
    objectKey: row["object_key"] as string,
    byteTotal: Number(row["byte_total"]),
    capturedAt: row["captured_at"] as Date,
    prunedAt: (row["pruned_at"] as Date | null) ?? null,
  };
}

export async function recordRunCapture(
  db: Queryable,
  capture: { engineeringRunId: string; bucket: string; objectKey: string; byteTotal: number; capturedAt?: Date },
): Promise<RunCapture> {
  return rowToRunCapture(
    await upsertRunCaptureRow(db, {
      engineeringRunId: capture.engineeringRunId,
      bucket: capture.bucket,
      objectKey: capture.objectKey,
      byteTotal: capture.byteTotal,
      capturedAt: capture.capturedAt ?? new Date(),
    }),
  );
}

export async function getRunCapture(db: Queryable, engineeringRunId: string): Promise<RunCapture | null> {
  const row = await selectRunCaptureRow(db, engineeringRunId);
  return row ? rowToRunCapture(row) : null;
}

export function captureExpiresAt(capture: RunCapture, retentionDays: number = CAPTURE_RETENTION_DAYS): Date {
  return new Date(capture.capturedAt.getTime() + retentionDays * 86_400_000);
}

async function listPrunableCaptures(db: Queryable, now: Date, retentionDays: number): Promise<RunCapture[]> {
  return (await selectPrunableCaptureRows(db, now, retentionDays)).map(rowToRunCapture);
}

async function pruneRunCapture(
  pool: Pool,
  storage: EvidenceStorage,
  capture: RunCapture,
  now: Date,
): Promise<boolean> {
  await storage.deletePackage(capture.bucket, capture.objectKey);
  return (await markRunCapturePruned(pool, capture.engineeringRunId, now, capture.capturedAt)) > 0;
}

export interface CaptureRetentionSweepResult {
  prunedRunIds: string[];
  interrupted: boolean;
}

export async function runCaptureRetentionSweep(
  pool: Pool,
  storage: EvidenceStorage,
  now: Date = new Date(),
  retentionDays: number = CAPTURE_RETENTION_DAYS,
  options: { signal?: AbortSignal } = {},
): Promise<CaptureRetentionSweepResult> {
  const candidates = await listPrunableCaptures(pool, now, retentionDays);
  const prunedRunIds: string[] = [];
  for (const capture of candidates) {
    if (options.signal?.aborted) return { prunedRunIds, interrupted: true };
    if (await pruneRunCapture(pool, storage, capture, now)) prunedRunIds.push(capture.engineeringRunId);
  }
  return { prunedRunIds, interrupted: false };
}
