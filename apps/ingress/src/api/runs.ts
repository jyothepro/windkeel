import { clampLimit, listRunsPage, runCostBreakdown } from "@windkeel/factory/runs";
import type { Page } from "@windkeel/api-contract";
import { batchOfRun } from "@windkeel/factory/batches";
import { assembleRunReport, renderRunReport } from "@windkeel/factory/runs";
import { listAgentRuns, listRepairAttempts, listVerificationRuns } from "@windkeel/factory/repositories";
import { runInOrganization } from "@windkeel/factory/tenancy";
import { FEED_START, listRunEvents, listRunEventsBefore, parseEventKinds } from "@windkeel/factory/runs";
import { listRunChanges, runChangesHead } from "@windkeel/factory/runs";
import { EvidenceFileNotFoundError, parseEvidenceRef } from "@windkeel/factory/execution";
import { TERMINAL_STATES } from "@windkeel/factory/runs";
import { takeoverFields } from "./takeover.js";
import { type ApiDeps, type ApiResult, type Query, type Scope, badRequest, byTimeThenKind, conflict, currentCursor, notFound, numeric, ok, storageUnconfigured } from "./common.js";

export async function runs(deps: ApiDeps, scope: Scope, query: Query): Promise<ApiResult> {
  const page = await listRunsPage(deps.pool, {
    organizationId: scope.organizationId,
    taskId: query.get("task"),
    repositoryId: query.get("repository"),

    batchId: query.get("batch") ?? query.get("batch_id"),
    status: query.get("status"),
    cursor: query.get("cursor"),
    limit: numeric(query.get("limit")),
  });
  return ok(page);
}

export async function run(deps: ApiDeps, scope: Scope, runId: string): Promise<ApiResult> {
  const row = await runInOrganization(deps.pool, scope.organizationId, runId);
  if (!row) return notFound("run");
  const report = await assembleRunReport(deps.pool, runId);
  const feed = await listRunEvents(deps.pool, runId, FEED_START, 1);
  return ok({
    report,

    rendered: renderRunReport(report),
    terminal: TERMINAL_STATES.has(row.status),

    modelConfig: row.modelConfig,

    cursor: await currentCursor(deps.pool, runId, feed.endCursor),

    batch: await batchOfRun(deps.pool, scope.organizationId, runId),

    receipt: await (await import("@windkeel/factory/billing")).runReceipt(deps.pool, runId),

    ...(await takeoverFields(deps, scope, row.id)),
  });
}

export async function runEvents(
  deps: ApiDeps,
  scope: Scope,
  runId: string,
  query: Query,
): Promise<ApiResult> {
  const exists = await runInOrganization(deps.pool, scope.organizationId, runId);
  if (!exists) return notFound("run");
  const kind = query.get("kind");
  const before = query.get("before");
  const last = query.get("last");
  const backwards = before !== undefined || last !== undefined;
  if (query.get("stream") === "sse" && (backwards || kind !== undefined)) {

    return badRequest("stream=sse follows the whole feed forward; it takes after=, not before=, last= or kind=");
  }
  if (backwards && query.get("after") !== undefined) return badRequest("after= reads forward and before=/last= backward; send one");
  const kinds = parseEventKinds(kind);
  const run = { runStatus: exists.status, terminal: TERMINAL_STATES.has(exists.status) };
  if (backwards) {

    const page = await listRunEventsBefore(deps.pool, runId, before ?? null, clampLimit(numeric(last ?? query.get("limit"))), kinds);
    return ok({ ...page, hasNextPage: before !== undefined, ...run });
  }
  const page = await listRunEvents(
    deps.pool,
    runId,
    query.get("after") ?? FEED_START,
    clampLimit(numeric(query.get("limit"))),
    kinds,
  );
  return ok({ ...page, ...run });
}

export async function runChanges(deps: ApiDeps, scope: Scope, query: Query): Promise<ApiResult> {
  const after = query.get("after");
  if (after === undefined || after === "") {
    return ok({ items: [], endCursor: await runChangesHead(deps.pool), hasNextPage: false, organizationId: scope.organizationId });
  }
  const page = await listRunChanges(deps.pool, scope.organizationId, after);
  return ok({ ...page, organizationId: scope.organizationId });
}

export async function runAttempts(deps: ApiDeps, scope: Scope, runId: string): Promise<ApiResult> {
  const exists = await runInOrganization(deps.pool, scope.organizationId, runId);
  if (!exists) return notFound("run");

  const [agents, verifications, repairs] = await Promise.all([
    listAgentRuns(deps.pool, runId),
    listVerificationRuns(deps.pool, runId),
    listRepairAttempts(deps.pool, runId),
  ]);

  const timeline = [
    ...agents.map((a) => ({
      kind: "agent_run" as const,
      at: a.startedAt,
      id: a.id,
      role: a.role,
      model: a.model,
      workerType: a.workerType,
      completedAt: a.completedAt,
      modelCost: a.modelCost,
    })),
    ...verifications.map((v) => ({
      kind: "verification" as const,
      at: v.startedAt,
      id: v.id,
      candidateSha: v.candidateSha,
      verdict: v.verdict,

      evidence: v.evidencePackageRef === null ? null : { available: v.evidencePrunedAt === null },
    })),
    ...repairs.map((r) => ({
      kind: "repair_attempt" as const,

      at: null,
      id: r.id,
      attemptNumber: r.attemptNumber,
      verificationRunId: r.verificationRunId,
      agentRunId: r.agentRunId,
    })),
  ].sort(byTimeThenKind);

  return ok({ items: timeline, endCursor: null, hasNextPage: false } satisfies Page<unknown>);
}

export async function runCost(deps: ApiDeps, scope: Scope, runId: string): Promise<ApiResult> {
  const exists = await runInOrganization(deps.pool, scope.organizationId, runId);
  if (!exists) return notFound("run");
  const breakdown = await runCostBreakdown(deps.pool, runId);
  return ok({
    ...breakdown,
    spendCapUsd: exists.spendCapUsd,

    runRowCost: exists.cost,
  });
}

export async function runEvidence(deps: ApiDeps, scope: Scope, runId: string): Promise<ApiResult> {
  const exists = await runInOrganization(deps.pool, scope.organizationId, runId);
  if (!exists) return notFound("run");
  if (!deps.evidence) return storageUnconfigured();

  const verifications = await listVerificationRuns(deps.pool, runId);
  const packages = [];
  for (const verification of verifications) {
    if (verification.evidencePackageRef === null) {
      packages.push({
        verificationRunId: verification.id,
        candidateSha: verification.candidateSha,
        verdict: verification.verdict,

        state: verification.evidencePrunedAt === null ? "never_produced" : "pruned",
        prunedAt: verification.evidencePrunedAt,
        manifestDigest: verification.evidenceManifestDigest,
        files: null,
      });
      continue;
    }
    const { bucket, key } = parseEvidenceRef(verification.evidencePackageRef);
    const keys = await deps.evidence.list(bucket, key);
    packages.push({
      verificationRunId: verification.id,
      candidateSha: verification.candidateSha,
      verdict: verification.verdict,
      state: "stored",
      prunedAt: null,
      manifestDigest: verification.evidenceManifestDigest,

      files: keys.map((full) => full.slice(`${key}/`.length)).sort(),
    });
  }
  return ok({ items: packages, endCursor: null, hasNextPage: false } satisfies Page<unknown>);
}

const EVIDENCE_URL_TTL_SECONDS = 300;

export async function runEvidenceFile(
  deps: ApiDeps,
  scope: Scope,
  runId: string,
  path: string,
  query: Query,
): Promise<ApiResult> {
  if (!(await runInOrganization(deps.pool, scope.organizationId, runId))) return notFound("run");
  if (!deps.evidence) return storageUnconfigured();
  if (path.includes("..")) {

    return badRequest("evidence path may not contain '..'", "invalid_path");
  }
  const verificationRunId = query.get("verification");
  const verifications = await listVerificationRuns(deps.pool, runId);
  const verification = verificationRunId
    ? verifications.find((v) => v.id === verificationRunId)
    :
      verifications[verifications.length - 1];

  if (!verification) return notFound("verification for run");
  if (verification.evidencePackageRef === null) {
    return conflict(
      verification.evidencePrunedAt === null
        ? "no evidence package was produced for this verification"
        : "the evidence package was removed by retention policy (ADR-0015)",
      "no_package",
    );
  }
  const { bucket, key } = parseEvidenceRef(verification.evidencePackageRef);
  const url = await deps.evidence.presign(bucket, key, path, EVIDENCE_URL_TTL_SECONDS);
  return { status: 302, body: { url }, headers: { location: url } };
}

interface StoredCandidate {
  candidateSha: string | null;
  workingBranch: string | null;
  diffRef: string | null;
  diffTruncated: boolean;
  filesChanged: string[];
}

function candidateOf(result: unknown): StoredCandidate | null {
  const c = (result as { candidate?: Partial<StoredCandidate> } | null)?.candidate;
  if (!c || typeof c.candidateSha !== "string") return null;
  return {
    candidateSha: c.candidateSha,
    workingBranch: c.workingBranch ?? null,
    diffRef: c.diffRef ?? null,
    diffTruncated: c.diffTruncated === true,
    filesChanged: Array.isArray(c.filesChanged) ? c.filesChanged : [],
  };
}

export async function runDiff(deps: ApiDeps, scope: Scope, runId: string, query: Query): Promise<ApiResult> {
  if (!(await runInOrganization(deps.pool, scope.organizationId, runId))) return notFound("run");

  const candidates: Array<StoredCandidate & { agentRunId: string; role: string }> = [];
  for (const agentRun of await listAgentRuns(deps.pool, runId)) {
    const candidate = candidateOf(agentRun.result);

    if (candidate && candidate.candidateSha !== candidates[candidates.length - 1]?.candidateSha) {
      candidates.push({ ...candidate, agentRunId: agentRun.id, role: agentRun.role });
    }
  }
  const listed = candidates.map((c) => ({ sha: c.candidateSha, agentRunId: c.agentRunId, role: c.role, filesChanged: c.filesChanged.length }));
  const wanted = query.get("sha");
  const chosen = wanted ? candidates.find((c) => c.candidateSha === wanted) : candidates[candidates.length - 1];
  if (!chosen) {
    if (wanted) return notFound("candidate for run");
    return conflict("this run has no candidate yet: the maker hasn't finished a change", "no_candidate");
  }

  const body = {
    candidateSha: chosen.candidateSha,
    workingBranch: chosen.workingBranch,
    filesChanged: chosen.filesChanged,
    truncated: chosen.diffTruncated,
    candidates: listed,
  };
  if (chosen.diffRef === null) {
    return conflict("the patch for this candidate was not stored: no evidence store was configured when it was made", "no_patch");
  }
  if (!deps.evidence?.read) return storageUnconfigured();
  const { bucket, key } = parseEvidenceRef(chosen.diffRef);
  let patch: string;
  try {
    patch = (await deps.evidence.read(bucket, key, "candidate.diff")).toString("utf8");
  } catch (err) {
    if (err instanceof EvidenceFileNotFoundError) return conflict("the stored patch is gone from the evidence store", "no_patch");
    throw err;
  }
  return ok({ ...body, patch });
}
