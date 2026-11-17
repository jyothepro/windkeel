

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVerificationEngine } from "@windkeel/verification/engine/engine.js";
import type { VerificationRequest } from "@windkeel/verification/engine/types.js";
import type { Author } from "@windkeel/verification/evidence/format.js";
import { runInExecutionPhase } from "../../../sandbox/lifecycle.js";
import type { SandboxHandle } from "../../../sandbox/provider.js";
import { recordRunAuditEvent, SYSTEM_ACTOR, withTransaction } from "../../audit-log.js";
import { enforceSpendAndTimeRails } from "../../rails-gate.js";
import {
  getAgentRun,
  getEngineeringRun,
  getEngineeringTask,
  getRepairAttemptForVerification,
  insertVerificationRun,
  listAgentRuns,
  listVerificationRuns,
  listWorkspaces,
  updateEngineeringRun,
  updateVerificationRun,
} from "../../repositories.js";
import { provisionWorkspace } from "../../workspace-service.js";
import { effectiveCriteria, playbookProvenance } from "../../playbooks.js";
import { resolveRepositoryTarget } from "../repository-target.js";
import type { StageContext, StageHandler, StageOutcome } from "../provider.js";
import { type StageDeps } from "../stage-deps.js";
import { gitCredentialsFor } from "./candidate-capture.js";
import { runCandidateHistory, runCandidateShas } from "../../human-session.js";
import { installSecretsFor } from "./install-secrets.js";
import { environmentFor, requestBuildAfter } from "./environment.js";
import { runBranchFor } from "../branch.js";
import { makerModelFor } from "../run-models.js";
import { CheckerKeyError, withCheckerModels } from "../checker-models.js";
import { endRepairLoop, ends, settleStage, type StageResult } from "./loop-exit.js";
import { outcomeFor, persist } from "./verifying-outcome.js";

const POLICY_VERSION_PREFIX = "windkeel-engine";

export function factoryRunner(engineeringRunId: string): string {
  return `windkeel-factory/${engineeringRunId}`;
}

export function createVerifyingHandler(deps: StageDeps): StageHandler {
  return {
    state: "VERIFYING",
    name: "verifying",

    async handle(context: StageContext): Promise<StageOutcome> {
      const engineeringRunId = context.engineeringRunId;
      let result: StageResult;
      try {
        result = await verify(deps, context);
      } catch (err) {

        await endRepairLoop(deps, engineeringRunId).catch(() => {});
        throw err;
      }
      return settleStage(deps, engineeringRunId, result);
    },
  };
}

async function verify(deps: StageDeps, context: StageContext): Promise<StageResult> {
  const { pool, sandboxes, registry, config } = deps;
  const engineeringRunId = context.engineeringRunId;

  const run = await getEngineeringRun(pool, engineeringRunId);
  if (!run) throw new Error(`verifying: engineering_run ${engineeringRunId} not found`);
  const task = await getEngineeringTask(pool, run.taskId);
  if (!task) throw new Error(`verifying: engineering_task for run ${engineeringRunId} not found`);

  const target = await resolveRepositoryTarget(pool, engineeringRunId, config.repository);

  const candidates = await runCandidates(pool, engineeringRunId);
  const candidateSha = candidates[candidates.length - 1];
  if (!candidateSha) {
    throw new Error(
      `verifying: run ${engineeringRunId} reached VERIFYING with no candidate sha on any ` +
        "AgentRun; M4.5's capture is what records it and a run without one has nothing to verify",
    );
  }
  const history = await runCandidateHistory(pool, engineeringRunId);
  const agentRun = (await listAgentRuns(pool, engineeringRunId)).find(
    (r) => candidateShaOf(r.result) === candidateSha,
  );

  const priorRuns = await listVerificationRuns(pool, engineeringRunId);

  const done = priorRuns.find((v) => v.candidateSha === candidateSha && v.verdict !== null);
  const abandoned = priorRuns.find(
    (v) => v.candidateSha === candidateSha && v.verdict === null && v.completedAt !== null,
  );
  if (!done && abandoned) {
    return ends({
      kind: "transition",
      to: "FAILED",
      reason:
        `verification ${abandoned.id} of candidate ${candidateSha} ended without reaching a ` +
        "verdict, so there is nothing to act on. Its failure is recorded on the delivery that " +
        "hit it; this delivery cannot re-run it, because the verifier sandbox is torn down " +
        "between deliveries (ADR-0004: a fresh one per verification).",
      stopReason: "error",
    });
  }
  if (done) {

    const attempt = await getRepairAttemptForVerification(pool, done.id);
    const repairer = attempt?.agentRunId ? await getAgentRun(pool, attempt.agentRunId) : null;
    if (repairer?.completedAt) {
      await updateEngineeringRun(pool, engineeringRunId, { stopReason: "stuck" });
      return ends({
        kind: "transition",
        to: "MAX_REPAIR_ATTEMPTS_REACHED",
        reason:
          `repair attempt ${attempt?.attemptNumber} produced no new candidate: the run branch is ` +
          `still at ${candidateSha}, which verification ${done.id} already judged ` +
          `${done.verdict}. A repairer that moves nothing is not making progress (ADR-0011 §3).`,
        stopReason: "stuck",
      });
    }
    return outcomeFor(deps, context, done.verdict, done.id);
  }

  const rails = await enforceSpendAndTimeRails(pool, engineeringRunId);
  if (rails.stopped) {
    return ends({ kind: "settled", observed: context.state, note: `rails: ${rails.reason}` });
  }
  if (await context.isCancellationRequested()) {
    return ends({ kind: "settled", observed: context.state, note: "cancellation observed" });
  }

  const verificationRun = await insertVerificationRun(pool, {
    engineeringRunId,
    candidateSha,
    policyVersion: `${POLICY_VERSION_PREFIX}@${config.policyVersion}`,
  });
  await updateVerificationRun(pool, verificationRun.id, { startedAt: new Date() });

  let packageDir: string | null = null;
  try {

    const verifierCredentials = await gitCredentialsFor(deps, engineeringRunId);

    const installSecrets = await installSecretsFor(deps, engineeringRunId);

    const base = await recordedBase(deps, engineeringRunId, candidates[0]!);

    const environment = await environmentFor(deps, engineeringRunId, "verifier");
    const provisioned = await provisionWorkspace(pool, sandboxes, {
      engineeringRunId,
      role: "verifier",
      ...(verifierCredentials ? { gitCredentials: verifierCredentials } : {}),
      ...(installSecrets ? { installSecrets } : {}),

      candidateTree: true,

      trustedBase: base,
      repository: target.url,
      baseSha: candidateSha,
      workingBranch: runBranchFor(engineeringRunId, task),
      expiresAt: new Date(Date.now() + config.workspaceTtlMs),

      installScanners: config.installScanners,
      ...(environment ? { environment } : {}),

      ...(task.playbook?.verifier.extraTools?.length ? { extraTools: task.playbook.verifier.extraTools } : {}),
    });
    registry.put(provisioned.workspace.id, provisioned.handle);
    await requestBuildAfter(deps, engineeringRunId, "verifier", provisioned.environment);

    const baseSha = await placeBase(provisioned.handle, config.modelApiDomain, base, candidateSha);
    const maker = await makerModelFor(deps, engineeringRunId);
    packageDir = mkdtempSync(join(tmpdir(), "windkeel-evidence-"));

    const request: Omit<VerificationRequest, "models"> = {

      execEnv: provisioned.handle,
      repo: provisioned.handle.checkoutPath,
      out: packageDir,
      subject: {
        repo: target.url,

        pr: null,
        base_sha: baseSha,
        head_sha: candidateSha,
        title: task.title,

        author: authorFor(history, candidateSha, {
          login: agentRun?.workerType ?? maker.workerType,
          agent: `${agentRun?.workerType ?? maker.workerType}/${agentRun?.model ?? maker.model}`,
        }),
      },
      runner: factoryRunner(engineeringRunId),
      prBody: "",
      issueBody: "",

      criteria: effectiveCriteria(task),

      ...(task.playbook ? { playbook: playbookProvenance(task.playbook)! } : {}),

      ...(provisioned.tools?.length ? { toolInstalls: provisioned.tools } : {}),

      ...(provisioned.scannerAssetDir ? { scannerAssetDir: provisioned.scannerAssetDir } : {}),
      ...(config.fakeSecurity ? { fakeSecurity: config.fakeSecurity } : {}),
      ...(config.signer ? { signer: config.signer } : {}),
    };

    const { result, checker } = await withCheckerModels(deps, engineeringRunId, async (models, info) => ({
      result: await createVerificationEngine().verify({ ...request, models }),
      checker: info,
    }));
    await persist(
      deps,
      engineeringRunId,
      verificationRun,
      result,
      packageDir,
      provisioned.dependencies,
      provisioned.tools,
      checker,
      provisioned.environment,
    );
    return outcomeFor(deps, context, result.verdict, verificationRun.id, result.repair);
  } catch (err) {

    await withTransaction(pool, async (tx) => {
      await updateVerificationRun(tx, verificationRun.id, { completedAt: new Date() });

      await recordRunAuditEvent(tx, engineeringRunId, {
        actor: SYSTEM_ACTOR,
        action: "run.verification_failed",
        detail: {
          verificationRunId: verificationRun.id,
          candidateSha: verificationRun.candidateSha,
          verdict: null,
          error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
        },
      });
    });
    return ends({
      kind: "transition",
      to: "FAILED",
      reason: `verification failed: ${err instanceof Error ? err.message : String(err)}`,

      stopReason: err instanceof CheckerKeyError ? err.stopReason : "error",
    });
  } finally {
    if (packageDir) rmSync(packageDir, { recursive: true, force: true });
  }
}

export function authorFor(
  history: Awaited<ReturnType<typeof runCandidateHistory>>,
  candidateSha: string,
  maker: { login: string; agent: string },
): Author {
  const index = history.findIndex((c) => c.sha === candidateSha);
  const upTo = index < 0 ? [] : history.slice(0, index + 1);
  const current = upTo[upTo.length - 1];
  if (!current || current.provenance === "maker") return { login: maker.login, kind: "agent", agent: maker.agent };
  const people = upTo.filter((c) => c.commitAuthor === "person");
  const person = people[people.length - 1]?.person?.login ?? "unknown";
  return {
    login: person,
    kind: current.provenance === "person" ? "human" : "agent",
    agent: maker.agent,
    provenance: current.provenance,
    commits: upTo.map((c) =>
      c.commitAuthor === "maker"
        ? { sha: c.sha, by: "maker" as const, ...(c.maker ? { agent: `${c.maker.harness}/${c.maker.model}` } : {}) }
        : { sha: c.sha, by: "person" as const, ...(c.person?.login ? { login: c.person.login } : {}) },
    ),
  };
}

function candidateShaOf(result: unknown): string | null {
  const candidate = (result as { candidate?: { candidateSha?: string | null } } | null)?.candidate;
  return candidate?.candidateSha ?? null;
}

export async function runCandidates(
  pool: StageDeps["pool"],
  engineeringRunId: string,
): Promise<string[]> {

  return runCandidateShas(pool, engineeringRunId);
}

async function recordedBase(
  deps: StageDeps,
  engineeringRunId: string,
  firstCandidateSha: string,
): Promise<string> {
  const makers = (await listWorkspaces(deps.pool, engineeringRunId)).filter((w) => w.role === "maker");
  const pinned = makers.filter((w) => isSha(w.baseSha));

  const maker = pinned.find((w) => w.status === "ready") ?? pinned[0];
  if (maker) return maker.baseSha;
  if (makers.length) return `${firstCandidateSha}^`;
  throw new Error(
    "verifying: the run has no maker workspace, so there is no recorded base the candidate can " +
      "be safely diffed against",
  );
}

const isSha = (s: string): boolean => /^[0-9a-f]{40}$/.test(s);

async function placeBase(
  handle: SandboxHandle,
  modelApiDomain: string,
  base: string,
  candidateSha: string,
): Promise<string> {
  const parsed = await runInExecutionPhase(handle, modelApiDomain, [], "git", {
    args: ["rev-parse", "--verify", `${base}^{commit}`],
  });
  const sha = parsed.stdout.trim().split("\n").pop()?.trim() ?? "";
  if (!isSha(sha)) {
    throw new Error(
      `verifying: could not resolve the run's recorded base ${base}: ` +
        `${parsed.error ?? parsed.stderr.trim()}`,
    );
  }
  const descends = await runInExecutionPhase(handle, modelApiDomain, [], "git", {
    args: ["merge-base", "--is-ancestor", sha, candidateSha],
  });
  if (descends.status !== 0) {
    throw new Error(
      `verifying: the candidate ${candidateSha} does not descend from the run's trusted base ` +
        `${sha}: ${descends.error ?? (descends.stderr.trim() || `exit ${descends.status}`)}`,
    );
  }
  return sha;
}
