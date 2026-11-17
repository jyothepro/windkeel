import { WorkerRouteChangedError } from "../../../worker/adapter.js";
import { recordCost } from "../../cost-ledger.js";
import { enforceSpendAndTimeRails } from "../rails-gate.js";
import {
  getEngineeringRun,
  getEngineeringTask,
  getAgentRun,
  getRepairAttemptForVerification,
  insertAgentRun,
  listAgentRuns,
  listVerificationRuns,
  listWorkspaces,
  updateAgentRun,
  updateRepairAttempt,
  updateWorkspace,
  type RepairAttempt,
  type VerificationRun,
} from "../../repositories.js";
import type { StageContext, StageHandler, StageOutcome } from "../provider.js";
import { modelCostUsd, pricingFor, type StageDeps } from "../stage-deps.js";
import { resolveRepairSession } from "../session-registry.js";
import {
  gitCredentialsFor,
  gitCredentialInstallerFor,
  captureCandidate,
  preservedNote,
  type CandidateCapture,
} from "./candidate-capture.js";
import { continues, endRepairLoop, ends, settleStage, type StageResult } from "./loop-exit.js";
import { makerTurnDestination } from "./human-editing.js";
import { makerModelFor } from "../run-models.js";
import { makerKeyFailureReason, MakerRouteError, makerRouteErrorOf, makerDepsFor, makerRouteFor } from "../maker-route.js";
import { acquireWorkspaceHandle } from "./attach-workspace.js";
import { makerWorkspaceOf, missingMakerReason } from "./maker-workspace.js";
import { clearSessionProgress, loadSessionProgress } from "./session-progress.js";
import { makerReleased, thrownStageReason } from "./session-recovery.js";
import { pollOutcome, pollSession } from "./session-turn.js";

export interface RepairAttemptResult {
  outcome: "completed" | "failed" | "cancelled";
  filesChanged: string[];
  tests: Array<{ command: string; exitCode: number | null; passed: boolean }>;
  error?: string;
  stoppedBy?: "spend_cap" | "wall_clock_cap" | "cancellation";
  agentRunId: string;
  candidateSha?: string | null;
  emptyChange?: boolean;
}

export function createRepairingHandler(deps: StageDeps): StageHandler {
  return {
    state: "REPAIRING",
    name: "repairing",
    async handle(context: StageContext): Promise<StageOutcome> {
      const engineeringRunId = context.engineeringRunId;
      let result: StageResult;
      try {
        result = await repair(deps, context);
      } catch (err) {
        const unusable = makerRouteErrorOf(err);
        if (!unusable) {
          await endRepairLoop(deps, engineeringRunId).catch(() => {});
          if (!(await makerReleased(deps, engineeringRunId))) throw err;
          return {
            kind: "transition",
            to: "FAILED",
            reason: thrownStageReason("repairing", err),
            stopReason: "error",
          };
        }
        result = ends({ kind: "transition", to: "FAILED", reason: unusable.message, stopReason: "model_policy" });
      }
      return settleStage(deps, engineeringRunId, result);
    },
  };
}

async function repair(stageDeps: StageDeps, context: StageContext): Promise<StageResult> {
  const deps = await makerDepsFor(stageDeps, context.engineeringRunId);
  const { pool, worker, config } = deps;
  const engineeringRunId = context.engineeringRunId;

  const { attempt } = await triggeringAttempt(pool, engineeringRunId);
  const run = await getEngineeringRun(pool, engineeringRunId);
  const task = run ? await getEngineeringTask(pool, run.taskId) : null;

  if (attempt.agentRunId) {
    const prior = await getAgentRun(pool, attempt.agentRunId);
    if (prior?.completedAt) {
      await clearSessionProgress(pool, prior.id);
      return continues({
        kind: "transition",
        to: "VERIFYING",
        reason: `repair attempt ${attempt.attemptNumber} already completed as agent run ${prior.id}`,
      });
    }
    const stillRunning = await loadSessionProgress(pool, attempt.agentRunId);
    if (!stillRunning) {
      return ends({
        kind: "transition",
        to: "FAILED",
        reason:
          `repair attempt ${attempt.attemptNumber} was started by a process that is gone ` +
          `(agent run ${attempt.agentRunId} never completed, and no session is in flight); a ` +
          "half-finished repair turn cannot be resumed or safely re-run, because the workspace " +
          "it was mutating is in an unknown state.",
        stopReason: "error",
      });
    }
  }

  const workspaces = await listWorkspaces(pool, engineeringRunId);
  const workspace = makerWorkspaceOf(workspaces);
  const handle = workspace ? await acquireWorkspaceHandle(deps, workspace) : undefined;
  if (!workspace || !handle) {
    if (workspace) await updateWorkspace(pool, workspace.id, { status: "orphaned" });
    return ends({
      kind: "transition",
      to: "FAILED",
      reason: workspace
        ? "the maker workspace the repair turn would run in could not be re-acquired — it has " +
          "expired, been destroyed, or the provider cannot reattach. ADR-0017 holds it alive " +
          "across the verification for exactly this turn."
        : missingMakerReason(workspaces, "there is no repair turn to take"),
      stopReason: "error",
    });
  }

  const resolved = await resolveRepairSession(deps, engineeringRunId, handle);
  if (!resolved.held) return ends(resolved.outcome!);
  const held = resolved.held;

  const rails = await enforceSpendAndTimeRails(pool, engineeringRunId, new Date(), { organizationBudget: true });
  if (rails.stopped) {
    return ends({ kind: "settled", observed: context.state, note: `rails: ${rails.reason}` });
  }
  if (await context.isCancellationRequested()) {
    return ends({ kind: "settled", observed: context.state, note: "cancellation observed" });
  }

  let makerRoute;
  try {
    makerRoute = await makerRouteFor(deps, engineeringRunId);
    worker.useRoute?.(held.session, makerRoute.route);
  } catch (error) {
    if (!(error instanceof MakerRouteError) && !(error instanceof WorkerRouteChangedError)) throw error;
    return ends({ kind: "transition", to: "FAILED", reason: error.message, stopReason: "model_policy" });
  }
  const route = makerRoute.route;

  const implementer = (await listAgentRuns(pool, engineeringRunId)).find(
    (r) => r.role === "implementer",
  );
  const resumingAgentRunId = attempt.agentRunId;
  const inFlight = resumingAgentRunId
    ? await loadSessionProgress(pool, resumingAgentRunId)
    : null;
  const maker = implementer ?? (await makerModelFor(deps, engineeringRunId));
  const agentRun = inFlight
    ? { id: resumingAgentRunId! }
    : await insertAgentRun(pool, {
        engineeringRunId,
        workerType: maker.workerType,
        model: maker.model,
        role: "repairer",
        tokenUsage: null,
      });
  if (!inFlight) {
    await updateAgentRun(pool, agentRun.id, { startedAt: new Date() });
    await updateRepairAttempt(pool, attempt.id, { agentRunId: agentRun.id });
  }

  try {
    if (!inFlight) await worker.send(held.session, { repairPacket: attempt.repairPacket });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateAgentRun(pool, agentRun.id, {
      completedAt: new Date(),
      result: { outcome: "failed", error: message, phase: "send" },
      modelCost: 0,
    });
    await updateRepairAttempt(pool, attempt.id, {
      result: {
        outcome: "failed",
        filesChanged: [],
        tests: [],
        error: message,
        agentRunId: agentRun.id,
      } satisfies RepairAttemptResult,
    });
    const unusable = makerRouteErrorOf(err);
    if (unusable) {
      return ends({ kind: "transition", to: "FAILED", reason: unusable.message, stopReason: "model_policy" });
    }
    return ends({
      kind: "transition",
      to: "FAILED",
      reason: `the repair turn could not be started: ${message}`,
      stopReason: "error",
    });
  }

  let preserved: CandidateCapture | null = null;

  const poll = await pollSession(deps, context, held.session, agentRun.id, {
    beforeTeardown: async () => {
      const stopped = await worker.result(held.session);
      preserved = await captureCandidate(pool, {
        handle,
        workspace,
        engineeringRunId,
        diff: stopped.diff,
        modelApiDomain: route.modelApiDomain,
        credentialRules: route.credentialRules,
        task,
        gitHost: config.gitHost,
        authorName: config.gitAuthorName,
        authorEmail: config.gitAuthorEmail,
        installGitCredential: gitCredentialInstallerFor(
          await gitCredentialsFor(deps, engineeringRunId),
          workspace,
          handle,
        ),
        storage: deps.evidence,
        mode: "advance",
      });
    },
  });
  if (!poll.finished) return continues(pollOutcome(deps));
  const summary = poll.summary;
  const result = await worker.result(held.session);

  const usage = result.usage;
  const usd = modelCostUsd(usage, pricingFor(maker.model, config.modelPricing));
  await updateAgentRun(pool, agentRun.id, {
    completedAt: new Date(),
    result: { ...summary, outcome: result.outcome },
    tokenUsage: usage ?? null,
    modelCost: usd,
  });
  await clearSessionProgress(pool, agentRun.id);
  await recordCost(pool, {
    engineeringRunId,
    stageType: "agent_run",
    stageId: agentRun.id,
    kind: "model",
    tokensIn: usage?.inputTokens ?? null,
    tokensOut: usage?.outputTokens ?? null,
    usd,
    keySource: makerRoute.keySource,
    credentialId: makerRoute.credential?.id ?? null,
    model: maker.model,
  });
  await recordAttemptResult(deps, attempt.id, agentRun.id, summary, result, null);

  if (summary.stoppedBy === "cancellation" || (await context.isCancellationRequested())) {
    return ends({
      kind: "settled",
      observed: context.state,
      note: `cancelled mid-repair${preservedNote(preserved)}`,
    });
  }
  if (summary.stoppedBy === "spend_cap" || summary.stoppedBy === "wall_clock_cap") {
    return ends({
      kind: "settled",
      observed: context.state,
      note: `rails: ${summary.stoppedBy}${preservedNote(preserved)}`,
    });
  }
  if (result.outcome === "cancelled") {
    return ends({ kind: "settled", observed: context.state, note: "worker reported cancelled" });
  }
  if (result.outcome === "failed") {
    const keyFailure = await makerKeyFailureReason(deps, makerRoute, result.error);
    if (keyFailure) {
      return ends({ kind: "transition", to: "FAILED", reason: keyFailure, stopReason: "model_policy" });
    }
    return ends({
      kind: "transition",
      to: "FAILED",
      reason: `repair turn failed: ${result.error ?? "no reason reported"}`,
      stopReason: "error",
    });
  }

  const candidate = await captureCandidate(pool, {
    handle,
    workspace,
    engineeringRunId,
    diff: result.diff,
    modelApiDomain: route.modelApiDomain,
    credentialRules: route.credentialRules,
    task,
    gitHost: config.gitHost,
    authorName: config.gitAuthorName,
    authorEmail: config.gitAuthorEmail,
    installGitCredential: gitCredentialInstallerFor(
      await gitCredentialsFor(deps, engineeringRunId),
      workspace,
      handle,
    ),
    storage: deps.evidence,
    mode: "advance",
  });
  await updateAgentRun(pool, agentRun.id, {
    result: { ...summary, outcome: result.outcome, candidate },
  });
  await recordAttemptResult(deps, attempt.id, agentRun.id, summary, result, candidate);

  return continues(
    await makerTurnDestination(deps, engineeringRunId, "REPAIRING", candidate.candidateSha, {
      kind: "transition",
      to: "VERIFYING",
      reason:
        `repair attempt ${attempt.attemptNumber} completed as agent run ${agentRun.id}` +
        (candidate.empty
          ? " but changed nothing; re-verification will stop the run as non-progress"
          : `, candidate ${candidate.candidateSha}`),
    }),
  );
}

async function recordAttemptResult(
  deps: StageDeps,
  attemptId: string,
  agentRunId: string,
  summary: { filesChanged: string[]; tests: RepairAttemptResult["tests"]; stoppedBy?: RepairAttemptResult["stoppedBy"] },
  result: { outcome: RepairAttemptResult["outcome"]; error?: string | undefined },
  candidate: { candidateSha: string | null; empty: boolean } | null,
): Promise<void> {
  await updateRepairAttempt(deps.pool, attemptId, {
    result: {
      outcome: result.outcome,
      filesChanged: summary.filesChanged,
      tests: summary.tests,
      agentRunId,
      ...(result.error ? { error: result.error } : {}),
      ...(summary.stoppedBy ? { stoppedBy: summary.stoppedBy } : {}),
      ...(candidate ? { candidateSha: candidate.candidateSha, emptyChange: candidate.empty } : {}),
    } satisfies RepairAttemptResult,
  });
}

async function triggeringAttempt(
  pool: StageDeps["pool"],
  engineeringRunId: string,
): Promise<{ verification: VerificationRun; attempt: RepairAttempt }> {
  const verifications = await listVerificationRuns(pool, engineeringRunId);
  const verification = [...verifications]
    .reverse()
    .find((v) => v.verdict === "fail" && v.completedAt !== null);
  if (!verification) {
    throw new Error(
      `repairing: run ${engineeringRunId} reached REPAIRING with no completed failing ` +
        "verification; a repair turn exists to answer a fail verdict and there is none",
    );
  }
  const attempt = await getRepairAttemptForVerification(pool, verification.id);
  if (!attempt) {
    throw new Error(
      `repairing: verification ${verification.id} failed but persisted no RepairAttempt; ` +
        "VERIFYING writes it from the engine's packet, and a fail with no packet is a bug there",
    );
  }
  return { verification, attempt };
}
