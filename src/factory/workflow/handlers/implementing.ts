

import { CODEX_API_KEY_PLACEHOLDER } from "../../../sandbox/credential-broker.js";
import { recordCost } from "../../cost-ledger.js";
import { recordBrowserUnavailable } from "../../agent-events.js";
import { enforceSpendAndTimeRails } from "../rails-gate.js";
import {
  getEngineeringRun,
  getEngineeringTask,
  insertAgentRun,
  listAgentRuns,
  listWorkspaces,
  updateAgentRun,
  updateWorkspace,
} from "../../repositories.js";
import type { StageContext, StageHandler, StageOutcome } from "../provider.js";
import { modelCostUsd, pricingFor, type StageDeps } from "../stage-deps.js";
import { acquireWorkspaceHandle } from "./attach-workspace.js";
import { makerWorkspaceOf, missingMakerReason } from "./maker-workspace.js";
import type { WorkerSession } from "../../../worker/adapter.js";
import {
  emptySessionSummary,
  pollOutcome,
  pollSession,
  recordSessionBinding,
  type AgentSessionSummary,
} from "./session-turn.js";
import { clearSessionProgress, loadSessionProgress, saveSessionProgress } from "./session-progress.js";
import { makerReleased, reacquireSession, recordLaunchedSession, thrownStageReason } from "./session-recovery.js";
import { continues, endRepairLoop, ends, settleStage, type StageResult } from "./loop-exit.js";
import { pendingHandback } from "../../human-session.js";
import { makerTurnDestination, resumeAfterHandback } from "./human-editing.js";
import { makerKeyFailureReason, MakerRouteError, makerRouteErrorOf, makerDepsFor, makerRouteFor } from "../maker-route.js";
import { makerKnowledge } from "../knowledge-flow.js";
import {
  EMPTY_CHANGE_POLICY,
  captureCandidate,
  gitCredentialsFor,
  preservedNote,
  gitCredentialInstallerFor,
} from "./candidate-capture.js";
import { buildMakerPrompt } from "./implementing-prompt.js";

export { buildMakerPrompt } from "./implementing-prompt.js";
export type { MakerPromptBrowser } from "./implementing-prompt.js";

export function createImplementingHandler(deps: StageDeps): StageHandler {
  return {
    state: "IMPLEMENTING",
    name: "implementing",

    async handle(context: StageContext): Promise<StageOutcome> {
      const engineeringRunId = context.engineeringRunId;
      let result: StageResult;
      try {
        result = await implement(deps, context);
      } catch (err) {

        const unusable = makerRouteErrorOf(err);
        if (!unusable) {
          await endRepairLoop(deps, engineeringRunId).catch(() => {});

          if (!(await makerReleased(deps, engineeringRunId))) throw err;
          return {
            kind: "transition",
            to: "FAILED",
            reason: thrownStageReason("implementing", err),
            stopReason: "error",
          };
        }
        result = ends({ kind: "transition", to: "FAILED", reason: unusable.message, stopReason: "model_policy" });
      }
      return settleStage(deps, engineeringRunId, result);
    },
  };
}

async function implement(stageDeps: StageDeps, context: StageContext): Promise<StageResult> {

  const deps = await makerDepsFor(stageDeps, context.engineeringRunId);
  const { pool, worker, config } = deps;
  const engineeringRunId = context.engineeringRunId;

  const handback = await pendingHandback(pool, engineeringRunId);
  if (handback) return resumeAfterHandback(deps, context, handback);

  const priorSessions = await listAgentRuns(pool, engineeringRunId);
  const implementer = priorSessions.find((r) => r.role === "implementer");
  if (implementer?.completedAt) {

    await clearSessionProgress(pool, implementer.id);

    if (!candidateShaOf(implementer)) {
      return ends({
        kind: "transition",
        to: "FAILED",
        reason:
          `agent session ${implementer.id} completed but recorded no candidate, so the capture ` +
          "that commits and pushes the agent's work did not finish. There is nothing for a " +
          "verifier to fetch, and the maker sandbox this delivery would need is gone.",
        stopReason: "error",
      });
    }
    return continues({
      kind: "transition",
      to: "VERIFYING",
      reason: `agent session ${implementer.id} already completed`,
    });
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
        ? "the maker workspace's sandbox could not be re-attached — it has expired, been " +
          "destroyed, or the provider cannot reattach (capabilities.reattachable). An " +
          "interrupted session cannot be resumed without it."
        : missingMakerReason(workspaces, "there is nothing to implement in"),
      stopReason: "error",
    });
  }

  const rails = await enforceSpendAndTimeRails(pool, engineeringRunId, new Date(), { organizationBudget: true });
  if (rails.stopped) {
    return ends({ kind: "settled", observed: context.state, note: `rails: ${rails.reason}` });
  }
  if (await context.isCancellationRequested()) {
    return ends({ kind: "settled", observed: context.state, note: "cancellation observed" });
  }

  const task = await getEngineeringTask(pool, (await requireRun(deps, engineeringRunId)).taskId);
  if (!task) throw new Error(`implementing: engineering_task for run ${engineeringRunId} not found`);

  let maker;
  try {
    maker = await makerRouteFor(deps, engineeringRunId);
  } catch (error) {
    if (!(error instanceof MakerRouteError)) throw error;
    return ends({ kind: "transition", to: "FAILED", reason: error.message, stopReason: "model_policy" });
  }
  const route = maker.route;
  const agentRun =
    implementer ??
    (await insertAgentRun(pool, {
      engineeringRunId,
      workerType: maker.workerType,
      model: maker.model,
      role: "implementer",
      tokenUsage: null,
    }));
  await updateAgentRun(pool, agentRun.id, { startedAt: new Date() });

  const inFlight = await loadSessionProgress(pool, agentRun.id);
  let session: WorkerSession;
  if (inFlight) {
    const acquired = await reacquireSession(deps, engineeringRunId, agentRun.id, inFlight, handle);
    if (!acquired.session) return ends(acquired.outcome);
    session = acquired.session;
  } else {

    await saveSessionProgress(pool, {
      agentRunId: agentRun.id,
      engineeringRunId,
      summary: emptySessionSummary(),
      sessionRef: null,
      polls: 0,
    });

    const knowledge = await makerKnowledge(deps, engineeringRunId, task);

    const browser = workspace.makerBrowser;
    if (browser?.status === "unavailable" && config.makerBrowser !== false) {
      await recordBrowserUnavailable(pool, engineeringRunId, agentRun.id, browser.reason).catch((err: unknown) => {
        console.warn(`browser_unavailable for run ${engineeringRunId} was not recorded: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    const prompt = buildMakerPrompt(
      task,
      knowledge,
      browser?.status === "installed" && config.makerBrowser !== false
        ? { helper: browser.helper, startCommand: browser.startCommand, port: browser.port }
        : undefined,
    );
    session = await worker.start({
      prompt,
      sandbox: handle,
      route,

      ...(deps.harnessVersion ? { harnessVersion: deps.harnessVersion } : {}),
    });

    await recordLaunchedSession(deps, engineeringRunId, agentRun.id, session);
  }

  worker.useRoute?.(session, route);

  deps.sessions.put(engineeringRunId, {
    session,
    workerType: worker.name,
    resumable: worker.capabilities.resumableSessions,
  });

  await recordSessionBinding(deps, engineeringRunId, session);

  let preserved: Awaited<ReturnType<typeof captureCandidate>> | null = null;

  const poll = await pollSession(deps, context, session, agentRun.id, {

    beforeTeardown: async () => {
      const stopped = await worker.result(session);
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
      });
    },
  });
  if (!poll.finished) return continues(pollOutcome(deps));
  const summary = poll.summary;
  const result = await worker.result(session);

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

    keySource: maker.keySource,
    credentialId: maker.credential?.id ?? null,
    model: maker.model,
  });

  if (summary.stoppedBy === "cancellation" || (await context.isCancellationRequested())) {
    return ends({
      kind: "settled",
      observed: context.state,
      note: `cancelled mid-session${preservedNote(preserved)}`,
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

    const keyFailure = await makerKeyFailureReason(deps, maker, result.error);
    if (keyFailure) {
      return ends({ kind: "transition", to: "FAILED", reason: keyFailure, stopReason: "model_policy" });
    }
    return ends({
      kind: "transition",
      to: "FAILED",
      reason: `worker session failed: ${result.error ?? "no reason reported"}`,
      stopReason: "error",
    });
  }

  let candidate: Awaited<ReturnType<typeof captureCandidate>>;
  try {
    candidate = await captureCandidate(pool, {
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
    });
  } catch (err) {
    const unusable = makerRouteErrorOf(err);
    if (unusable) {
      return ends({ kind: "transition", to: "FAILED", reason: unusable.message, stopReason: "model_policy" });
    }
    return ends({
      kind: "transition",
      to: "FAILED",
      reason: `candidate capture failed: ${err instanceof Error ? err.message : String(err)}`,
      stopReason: "error",
    });
  }
  await updateAgentRun(pool, agentRun.id, {
    result: { ...summary, outcome: result.outcome, candidate },
  });

  if (candidate.empty) {
    return ends({
      kind: "transition",
      to: EMPTY_CHANGE_POLICY.runState,
      reason: EMPTY_CHANGE_POLICY.reason,
    });
  }

  return continues(
    await makerTurnDestination(deps, engineeringRunId, "IMPLEMENTING", candidate.candidateSha, {
      kind: "transition",
      to: "VERIFYING",
      reason: `agent session ${agentRun.id} produced candidate ${candidate.candidateSha}`,
    }),
  );
}

function candidateShaOf(agentRun: { result: unknown }): string | null {
  const result = agentRun.result as { candidate?: { candidateSha?: string | null } } | null;
  return result?.candidate?.candidateSha ?? null;
}

async function requireRun(deps: StageDeps, engineeringRunId: string) {
  const run = await getEngineeringRun(deps.pool, engineeringRunId);
  if (!run) throw new Error(`implementing: engineering_run ${engineeringRunId} not found`);
  return run;
}

export type { AgentSessionSummary };

export { CODEX_API_KEY_PLACEHOLDER };
