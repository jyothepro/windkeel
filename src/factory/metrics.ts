import type { Pool } from "pg";
import { selectMetricsView } from "./stores/metrics-store.js";

const VIEWS = [
  "task_success_rate",
  "first_pass_verification_rate",
  "repair_success_rate",
  "human_rework_rate",
  "merge_rate",
  "cost_per_verified_pr",
  "verified_work_merged_without_rework",
] as const;

const PER_RUN_VIEWS = [
  "time_to_pr",
  "sandbox_duration",
  "model_tokens",
  "model_cost",
  "sandbox_cost",
  "verification_cost",
  "repair_attempts_per_run",
] as const;

export interface MetricsReport {
  summary: Record<string, Record<string, unknown>>;
  perRun: Record<string, Array<Record<string, unknown>>>;
}

export async function collectMetrics(pool: Pool): Promise<MetricsReport> {
  const summary: MetricsReport["summary"] = {};
  for (const view of VIEWS) {
    const rows = await selectMetricsView(pool, view);
    summary[view] = rows[0] ?? {};
  }
  const perRun: MetricsReport["perRun"] = {};
  for (const view of PER_RUN_VIEWS) {
    perRun[view] = await selectMetricsView(pool, view);
  }
  return { summary, perRun };
}
