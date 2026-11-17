import type { Pool } from "pg";
import type { EvidenceStorage } from "./evidence-storage.js";
import { listPrunableVerificationRuns, updateVerificationRun, type VerificationRun } from "./repositories.js";

const DEFAULT_RETENTION_DAYS = 90;

function parseRef(ref: string): { bucket: string; key: string } {
  const slash = ref.indexOf("/");
  if (slash < 0) throw new Error(`malformed evidence_package_ref: ${ref}`);
  return { bucket: ref.slice(0, slash), key: ref.slice(slash + 1) };
}

export async function pruneVerificationRun(
  pool: Pool,
  storage: EvidenceStorage,
  run: VerificationRun,
  now: Date,
): Promise<VerificationRun> {
  if (!run.evidencePackageRef) return run;
  const { bucket, key } = parseRef(run.evidencePackageRef);
  await storage.deletePackage(bucket, key);
  return updateVerificationRun(pool, run.id, { evidencePackageRef: null, evidencePrunedAt: now });
}

export interface RetentionSweepResult {
  prunedIds: string[];
  interrupted: boolean;
}

export interface RetentionSweepOptions {
  signal?: AbortSignal;
}

export async function runRetentionSweep(
  pool: Pool,
  storage: EvidenceStorage,
  now: Date = new Date(),
  retentionDays: number = DEFAULT_RETENTION_DAYS,
  options: RetentionSweepOptions = {},
): Promise<RetentionSweepResult> {
  const candidates = await listPrunableVerificationRuns(pool, now, retentionDays);
  const prunedIds: string[] = [];
  for (const run of candidates) {
    if (options.signal?.aborted) return { prunedIds, interrupted: true };
    await pruneVerificationRun(pool, storage, run, now);
    prunedIds.push(run.id);
  }
  return { prunedIds, interrupted: false };
}
