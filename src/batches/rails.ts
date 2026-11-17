import type { RunState } from "../factory/run-state-machine.js";
import { TERMINAL_STATES } from "../factory/run-state-machine.js";
import { DEFAULT_SPEND_CAP_USD } from "../factory/rails.js";

export const DEFAULT_BATCH_SPEND_CAP_USD = 100;
export const DEFAULT_MAX_CONCURRENCY = 3;
export const MAX_CONCURRENCY_LIMIT = 50;
export const DEFAULT_ORG_MAX_CONCURRENT_RUNS = 10;
export const DEFAULT_BATCH_MAX_ITEMS = 200;
const FAILURE_RATIO_MIN_SETTLED = 3;

export type BatchStopReason = "batch_spend_cap" | "failure_ratio";

export class UncappedBatchError extends Error {
  override readonly name = "UncappedBatchError";
}

export function batchRails(options: { spendCapUsd?: number | null; uncappedConfirmed?: boolean } = {}): {
  batch_spend_cap_usd: number | null;
} {
  const cap = options.spendCapUsd === undefined ? DEFAULT_BATCH_SPEND_CAP_USD : options.spendCapUsd;
  if (cap === null && !options.uncappedConfirmed) {
    throw new UncappedBatchError(
      "batch_spend_cap_usd: null leaves the batch uncapped; pass uncapped_confirmed: true to do that deliberately",
    );
  }
  return { batch_spend_cap_usd: cap };
}

export function occupiesSlot(status: RunState): boolean {
  return !TERMINAL_STATES.has(status) && status !== "WAITING_FOR_HUMAN";
}

export function holdsBudget(status: RunState): boolean {
  return !TERMINAL_STATES.has(status);
}

export function isSettled(status: RunState): boolean {
  return TERMINAL_STATES.has(status) || status === "WAITING_FOR_HUMAN";
}

export function isSucceeded(status: RunState, finalVerdict: string | null): boolean {
  return status === "COMPLETED" || (status === "WAITING_FOR_HUMAN" && finalVerdict === "pass");
}

export function isFailed(status: RunState): boolean {
  return status === "FAILED" || status === "MAX_REPAIR_ATTEMPTS_REACHED";
}

export function batchFreeSlots(input: {
  maxConcurrency: number;
  active: number;
  orgMaxConcurrentRuns: number;
  orgActive: number;
}): number {
  const free = Math.min(input.maxConcurrency - input.active, input.orgMaxConcurrentRuns - input.orgActive);
  return Math.max(0, Math.floor(free));
}

export function batchStopReason(input: {
  spend: number;
  cap: number | null;
  settled: number;
  failed: number;
  ratio: number | null;
}): BatchStopReason | null {
  if (input.cap !== null && input.spend >= input.cap) return "batch_spend_cap";
  if (
    input.ratio !== null &&
    input.failed > 0 &&
    input.settled >= FAILURE_RATIO_MIN_SETTLED &&
    input.failed / input.settled >= input.ratio
  ) {
    return "failure_ratio";
  }
  return null;
}

export function childSpendCap(remaining: number | null, templateCap: number = DEFAULT_SPEND_CAP_USD): number | null {
  if (remaining === null) return templateCap;
  if (!(remaining > 0)) return null;
  return Math.floor(Math.min(templateCap, remaining) * 100) / 100 || null;
}

export function batchOutcome(input: { items: number; succeeded: number }): "COMPLETED" | "PARTIAL" | "FAILED" {
  if (input.items > 0 && input.succeeded === input.items) return "COMPLETED";
  if (input.succeeded === 0) return "FAILED";
  return "PARTIAL";
}

export function positiveIntFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
