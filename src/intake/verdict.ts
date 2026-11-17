import type { Pool, PoolClient } from "pg";
import { selectLatestVerdict } from "./stores/intake-store.js";

export type VerdictResult = "pass" | "warn" | "fail";

export interface RunVerdict {
  result: VerdictResult;
  passed: number;
  failed: number;
  total: number;
  blocking: number;
  summary: string;
}

const VERDICTS: ReadonlySet<string> = new Set(["pass", "warn", "fail"]);

function countOf(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  return 0;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function isVerified(verdict: RunVerdict | null | undefined): boolean {
  return Boolean(verdict && verdict.result !== "fail" && verdict.failed === 0);
}

export function verdictFromRow(row: {
  verdict?: unknown;
  risk_summary?: unknown;
  criteria_count?: unknown;
}): RunVerdict | null {
  const result = row.verdict;
  if (typeof result !== "string" || !VERDICTS.has(result)) return null;
  const risk = (row.risk_summary && typeof row.risk_summary === "object" ? row.risk_summary : {}) as Record<string, unknown>;
  const passed = countOf(risk["satisfied"]);
  const failed = countOf(risk["unsatisfied"]);
  const blocking = countOf(risk["blocking"]);
  const total = Math.max(countOf(row.criteria_count), passed + failed);
  const verdict: RunVerdict = { result: result as VerdictResult, passed, failed, total, blocking, summary: "" };
  verdict.summary = verdictSummary(verdict);
  return verdict;
}

function verdictSummary(v: Omit<RunVerdict, "summary">): string {
  const findings = v.blocking > 0 ? `, ${plural(v.blocking, "blocking finding", "blocking findings")}` : "";
  if (v.result !== "fail" && v.failed === 0) {
    const warned = v.result === "warn" ? " (with warnings)" : "";
    return `${v.passed}/${v.total} criteria met${warned}${findings}`;
  }
  if (v.failed > 0) return `${v.failed} of ${v.total} criteria failed${findings}`;
  return `verification failed${findings || " (no criterion was settled)"}`;
}

export async function verdictForRun(db: Pool | PoolClient, engineeringRunId: string): Promise<RunVerdict | null> {
  try {
    const { rows } = await selectLatestVerdict(db, engineeringRunId);
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? verdictFromRow(row) : null;
  } catch {
    return null;
  }
}

export const VERIFYING_TEXT = "Verifying in an independent sandbox…";

export function verdictLine(verdict: RunVerdict | null | undefined): string {
  if (!verdict) return "No verification result";
  if (isVerified(verdict)) {
    const warned = verdict.result === "warn" ? " (with warnings)" : "";
    return `Verified ✓ ${verdict.passed}/${verdict.total} criteria${warned}`;
  }
  return `Not verified: ${verdict.summary}`;
}

export function verifyingClaimKey(runId: string): string {
  return `verifying:${runId}`;
}
