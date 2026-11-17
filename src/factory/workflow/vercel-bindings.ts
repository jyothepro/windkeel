

import type { Pool } from "pg";
import {
  bindingExists,
  markTickBudgetExhausted,
  selectBinding,
  selectBindingToken,
  touchOwnedBinding,
  updateBindingPhase,
} from "./stores/workflow-run-binding-store.js";
import {
  consumeSignals,
  hasUnconsumedSignal,
  selectCancellation,
  signalOrCancellationSince,
} from "./stores/run-signal-store.js";
import type { DeliveredSignal, RunSignal } from "./provider.js";

export type BindingPhase = "queued" | "running" | "waiting" | "retrying" | "finished";

export interface Binding {
  executionHandle: string;
  phase: string;
  attempt: number;
}

export async function hasPendingSignal(pool: Pool, engineeringRunId: string): Promise<boolean> {
  return hasUnconsumedSignal(pool, engineeringRunId);
}

export async function arrivedSince(pool: Pool, engineeringRunId: string, since: Date): Promise<boolean> {
  return signalOrCancellationSince(pool, engineeringRunId, since);
}

export async function recordTickBudgetExhausted(
  pool: Pool,
  engineeringRunId: string,
  executionToken?: string,
): Promise<void> {

  await markTickBudgetExhausted(pool, engineeringRunId, executionToken ?? null);
}

export async function claimTick(pool: Pool, engineeringRunId: string, executionToken?: string): Promise<boolean> {
  const rowCount = await touchOwnedBinding(pool, engineeringRunId, executionToken ?? null);
  if (rowCount) return true;
  return !(await bindingExists(pool, engineeringRunId));
}

export async function stillOwns(pool: Pool, engineeringRunId: string, executionToken?: string): Promise<boolean> {
  const row = await selectBindingToken(pool, engineeringRunId);
  if (!row) return true;
  return ((row.execution_token) ?? undefined) === executionToken;
}

export async function setPhase(
  pool: Pool,
  engineeringRunId: string,
  phase: BindingPhase,
  attempt: number,
  ...fence: [executionToken?: string]
): Promise<Date | null> {

  return updateBindingPhase(pool, engineeringRunId, phase, attempt, fence);
}

export async function readBinding(pool: Pool, engineeringRunId: string): Promise<Binding | null> {
  return selectBinding(pool, engineeringRunId);
}

export async function isCancellationRequested(pool: Pool, engineeringRunId: string): Promise<boolean> {
  return (await selectCancellation(pool, engineeringRunId)).length > 0;
}

export async function takeSignals(pool: Pool, engineeringRunId: string): Promise<DeliveredSignal[]> {
  const rows = await consumeSignals(pool, engineeringRunId);
  return rows.map((row) => ({
    id: row.id,
    engineeringRunId: row.engineering_run_id,
    signal: { type: row.kind, ...(row.payload as object) } as RunSignal,
    receivedAt: row.received_at,
  }));
}
