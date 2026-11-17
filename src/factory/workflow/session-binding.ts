import type { Pool, PoolClient } from "pg";
import type { WorkerSessionRef } from "../../worker/adapter.js";
import { deleteSessionBinding, selectSessionBindingRow, upsertSessionBinding } from "./stores/session-store.js";

type Queryable = Pool | PoolClient;

export interface WorkerSessionBinding {
  readonly workerType: string;
  readonly sessionRef: WorkerSessionRef;
  readonly resumable: boolean;
}

export async function loadSessionBinding(
  db: Queryable,
  engineeringRunId: string,
): Promise<WorkerSessionBinding | null> {
  const row = await selectSessionBindingRow(db, engineeringRunId);
  if (!row) return null;
  return {
    workerType: row["worker_type"] as string,
    sessionRef: row["session_ref"] as WorkerSessionRef,
    resumable: row["resumable"] as boolean,
  };
}

export async function saveSessionBinding(
  db: Queryable,
  engineeringRunId: string,
  binding: WorkerSessionBinding,
): Promise<void> {
  await upsertSessionBinding(db, engineeringRunId, binding.workerType, JSON.stringify(binding.sessionRef), binding.resumable);
}

export async function clearSessionBinding(db: Queryable, engineeringRunId: string): Promise<void> {
  await deleteSessionBinding(db, engineeringRunId);
}
