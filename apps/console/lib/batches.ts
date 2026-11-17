import { RUN_STATES, stateLabel, type RunState } from "./run-states.ts";

import type { BatchItem, BatchProgress, BatchStatus } from "@windkeel/api-contract";
export type { BatchStatus, BatchProgress, BatchView, BatchItem, BatchDetail } from "@windkeel/api-contract";

export const SETTLED_BATCH: ReadonlySet<BatchStatus> = new Set(["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"]);

export const BATCH_STATUS_LABEL: Record<BatchStatus, string> = {
  RUNNING: "Running",
  PAUSED: "Paused",
  STOPPING: "Stopping",
  COMPLETED: "Completed",
  PARTIAL: "Partly done",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

export const STOP_REASON_LABEL: Record<string, string> = {
  batch_spend_cap: "the batch reached its spending cap; children already running finish, no new ones start",
  failure_ratio: "too many children failed; children already running finish, no new ones start",
  cancelled: "cancelled",
};

export function progressSegments(p: BatchProgress): Array<{ key: "succeeded" | "failed" | "active" | "waiting" | "skipped"; count: number; label: string }> {
  const other = Math.max(0, p.settled - p.succeeded - p.failed);
  const segments = [
    { key: "succeeded" as const, count: p.succeeded, label: "verified" },
    { key: "failed" as const, count: p.failed + other, label: "failed or stopped" },
    { key: "active" as const, count: p.active, label: "running" },
    { key: "waiting" as const, count: p.pending, label: "waiting for a slot" },
    { key: "skipped" as const, count: p.skipped, label: "skipped" },
  ];
  return segments.filter((s) => s.count > 0);
}

export function usd(n: number | null): string {
  return n === null ? "no cap" : `$${n.toFixed(2)}`;
}

export function batchControls(status: BatchStatus, permissions: readonly string[]): Array<"pause" | "resume" | "cancel"> {
  if (!permissions.includes("batches.manage") || SETTLED_BATCH.has(status)) return [];
  const out: Array<"pause" | "resume" | "cancel"> = [];
  if (status === "RUNNING") out.push("pause");
  if (status === "PAUSED") out.push("resume");
  out.push("cancel");
  return out;
}

export function itemState(item: BatchItem): string {
  if (item.state === "pending") return "Waiting for a slot";
  if (item.state === "skipped") return item.skipReason === "repository_not_granted" ? "Skipped: repository no longer granted" : "Skipped";
  const status = item.runStatus;
  if (status && (RUN_STATES as readonly string[]).includes(status)) return stateLabel(status as RunState);
  return status ?? "Started";
}
