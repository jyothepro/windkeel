

import type { Pool, PoolClient } from "pg";
import { assembleRunReport, type RunReport } from "./run-report.js";
import { getEngineeringTask } from "./repositories.js";
import { getRepository } from "./repository-entity.js";
import { getPrincipal, organizationsFor, runInOrganization } from "./tenancy.js";
import { getGithubUserAuthorization, type GithubUserAuthorization } from "./github-user-tokens.js";
import type { NeedsALookItem, VerdictOfRecordFacts } from "./merge-eligibility.js";
import { recordAuditEvent, withTransaction } from "./audit-log.js";
import {
  heartbeatRunMergeRow,
  insertRunMergeRow,
  selectLatestRunMergeRow,
  selectOrganizationAllowMerge,
  selectRunMergeRow,
  settleRunMergeRow,
  updateOrganizationAllowMerge,
} from "./stores/run-merge-store.js";

type Db = Pool | PoolClient;

export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export interface MergeContext {
  engineeringRunId: string;
  runStatus: string;
  repository: { id: string; owner: string; name: string } | null;
  prNumber: number | null;
  verdictOfRecord:
    | (VerdictOfRecordFacts & { verificationRunId: string; digest: string | null; needsALook: NeedsALookItem[] })
    | null;
  allowMerge: boolean;
  permissions: string[];
  authorization: GithubUserAuthorization | null;
  linkedGithubUserId: number | null;
}

export function mergeEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["WINDKEEL_MERGE"]?.trim() === "1";
}

export function needsALookItems(report: RunReport): NeedsALookItem[] {
  const record = report.verifications.find((v) => v.verdictOfRecord);
  if (!record || record.verdict !== "warn") return [];
  const items: NeedsALookItem[] = [];
  for (const s of report.incompleteStages) {
    items.push({ id: `incomplete:${s.stage}:${s.tool}`, title: `${s.stage}: test unavailable — ${s.tool} did not finish` });
  }
  const risk = (record.riskSummary ?? {}) as { nonBlocking?: unknown; unsatisfied?: unknown };
  for (const id of stringList(risk.nonBlocking)) {
    items.push({ id: `finding:${id}`, title: `A finding the verifier didn't block on: ${id}` });
  }
  for (const id of stringList(risk.unsatisfied)) {
    items.push({ id: `criterion:${id}`, title: `A criterion the verifier couldn't confirm: ${id}` });
  }
  if (report.task.criteriaProvenance === "generated" && !report.task.criteriaApprovedBy) {
    items.push({ id: "criteria-unapproved", title: "Criteria were never approved — a model wrote the bar this was judged against" });
  }
  if (items.length === 0) items.push({ id: "warn", title: "The verifier returned warn: some things could not be settled" });
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && x !== "") : [];
}

export async function loadMergeContext(
  pool: Pool,
  input: { organizationId: string; engineeringRunId: string; principalId: string },
): Promise<MergeContext | null> {
  const run = await runInOrganization(pool, input.organizationId, input.engineeringRunId);
  if (!run) return null;
  const task = await getEngineeringTask(pool, run.taskId);
  if (!task) return null;
  const repo = await getRepository(pool, task.repositoryId);
  const report = await assembleRunReport(pool, run.id);
  const record = report.verifications.find((v) => v.verdictOfRecord) ?? null;
  const allowMerge = await selectOrganizationAllowMerge(pool, input.organizationId);
  const access = (await organizationsFor(pool, input.principalId)).find((o) => o.id === input.organizationId);
  const principal = await getPrincipal(pool, input.principalId);
  return {
    engineeringRunId: run.id,
    runStatus: run.status,
    repository: repo ? { id: repo.id, owner: repo.owner, name: repo.name } : null,
    prNumber: run.prNumber,
    verdictOfRecord: record
      ? {
          verificationRunId: record.id,
          candidateSha: record.candidateSha,
          verdict: record.verdict,
          digest: record.evidence.manifestDigest,
          needsALook: needsALookItems(report),
        }
      : null,
    allowMerge: allowMerge === true,
    permissions: access?.permissions ?? [],
    authorization: await getGithubUserAuthorization(pool, input.principalId),
    linkedGithubUserId: principal?.githubUserId ?? null,
  };
}

export interface RunMerge {
  id: string;
  engineeringRunId: string;
  organizationId: string;
  principalId: string;
  repositoryId: string;
  prNumber: number;
  verifiedSha: string;
  mergedSha: string | null;
  verificationRunId: string;
  verdict: "pass" | "warn";
  verdictDigest: string | null;
  acknowledgements: NeedsALookItem[];
  markReady: boolean;
  mergeMethod: MergeMethod;
  status: "pending" | "merged" | "refused" | "failed";
  reason: string | null;
  githubLogin: string | null;
  createdAt: Date;
  completedAt: Date | null;

  heartbeatAt: Date | null;

  mergeSentAt: Date | null;
}

function mapMerge(row: Record<string, unknown>): RunMerge {
  return {
    id: row["id"] as string,
    engineeringRunId: row["engineering_run_id"] as string,
    organizationId: row["organization_id"] as string,
    principalId: row["principal_id"] as string,
    repositoryId: row["repository_id"] as string,
    prNumber: Number(row["pr_number"]),
    verifiedSha: row["verified_sha"] as string,
    mergedSha: (row["merged_sha"] as string | null) ?? null,
    verificationRunId: row["verification_run_id"] as string,
    verdict: row["verdict"] as RunMerge["verdict"],
    verdictDigest: (row["verdict_digest"] as string | null) ?? null,
    acknowledgements: (row["acknowledgements"] as NeedsALookItem[]) ?? [],
    markReady: row["mark_ready"] === true,
    mergeMethod: row["merge_method"] as MergeMethod,
    status: row["status"] as RunMerge["status"],
    reason: (row["reason"] as string | null) ?? null,
    githubLogin: (row["github_login"] as string | null) ?? null,
    createdAt: row["created_at"] as Date,
    completedAt: (row["completed_at"] as Date | null) ?? null,
    heartbeatAt: (row["heartbeat_at"] as Date | null) ?? null,
    mergeSentAt: (row["merge_sent_at"] as Date | null) ?? null,
  };
}

export class MergeInProgressError extends Error {
  override name = "MergeInProgressError";
}

export async function insertRunMerge(
  db: Db,
  input: Omit<RunMerge, "id" | "mergedSha" | "status" | "reason" | "githubLogin" | "createdAt" | "completedAt" | "heartbeatAt" | "mergeSentAt">,
): Promise<RunMerge> {
  try {
    return mapMerge(
      await insertRunMergeRow(db, {
        engineeringRunId: input.engineeringRunId,
        organizationId: input.organizationId,
        principalId: input.principalId,
        repositoryId: input.repositoryId,
        prNumber: input.prNumber,
        verifiedSha: input.verifiedSha,
        verificationRunId: input.verificationRunId,
        verdict: input.verdict,
        verdictDigest: input.verdictDigest,
        acknowledgements: JSON.stringify(input.acknowledgements),
        markReady: input.markReady,
        mergeMethod: input.mergeMethod,
      }),
    );
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new MergeInProgressError("a merge of this run is already in progress");
    throw err;
  }
}

export async function getRunMerge(db: Db, id: string): Promise<RunMerge | null> {
  const row = await selectRunMergeRow(db, id);
  return row ? mapMerge(row) : null;
}

export async function latestRunMerge(db: Db, engineeringRunId: string): Promise<RunMerge | null> {
  const row = await selectLatestRunMergeRow(db, engineeringRunId);
  return row ? mapMerge(row) : null;
}

export async function completeRunMerge(
  db: Db,
  id: string,
  outcome: { status: "merged" | "refused" | "failed"; reason?: string | null; mergedSha?: string | null; githubLogin?: string | null },
): Promise<RunMerge | null> {
  return withTransaction(db, async (tx) => {
    const row = await settleRunMergeRow(tx, id, {
      status: outcome.status,
      reason: outcome.reason?.slice(0, 500) ?? null,
      mergedSha: outcome.mergedSha ?? null,
      githubLogin: outcome.githubLogin ?? null,
    });
    if (!row) return null;
    const merge = mapMerge(row);
    const person = await getPrincipal(tx, merge.principalId);
    await recordAuditEvent(tx, {
      organizationId: merge.organizationId,
      actor: {
        principalId: merge.principalId,
        text: merge.githubLogin ?? person?.githubLogin ?? person?.displayName ?? merge.principalId,
        kind: "user",
      },
      action: merge.status === "merged" ? "run.merged" : "run.merge_failed",
      target: { type: "run", id: merge.engineeringRunId },
      detail: {
        runMergeId: merge.id,
        status: merge.status,
        prNumber: merge.prNumber,
        verificationRunId: merge.verificationRunId,
        verifiedSha: merge.verifiedSha,
        mergedSha: merge.mergedSha,
        verdict: merge.verdict,
        ...(merge.reason ? { reason: merge.reason } : {}),
      },
    });
    return merge;
  });
}

export async function heartbeatRunMerge(db: Db, id: string, options: { mergeSent?: boolean } = {}): Promise<boolean> {
  return (await heartbeatRunMergeRow(db, id, options.mergeSent === true)) === 1;
}

export async function setAllowMerge(db: Db, organizationId: string, allow: boolean): Promise<boolean> {
  return (await updateOrganizationAllowMerge(db, organizationId, allow)) === true;
}

export async function getAllowMerge(db: Db, organizationId: string): Promise<boolean> {
  return (await selectOrganizationAllowMerge(db, organizationId)) === true;
}
