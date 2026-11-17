

import { getAgentRun, getEngineeringRun, getEngineeringTask, insertAgentRun, listAgentRuns, listWorkspaces, updateAgentRun } from "../../repositories.js";
import { checkCaps, parkedSeconds } from "../../rails.js";
import { listRunStateTransitions } from "../../repositories.js";
import { recordCost } from "../../cost-ledger.js";
import { claimPendingGuidance, markGuidanceDelivered, renderGuidance } from "../../run-guidance.js";
import { chargeSandboxUsage } from "../../workspace-service.js";
import type { HostExec, PushTokenIssuer } from "../../human-push.js";
import {
  claimPendingTakeover,
  liveHumanSession,
  listHumanSessions,
  principalGithubIdentity,
  requestHumanSession,
  taskSessionMode,
  updateHumanSession,
  type HumanSession,
} from "../../human-session.js";
import {
  HUMAN_WORKSPACE_IDLE_SLEEP_MS,
  HUMAN_WORKSPACE_MAX_LIFETIME_MS,
  provisionHumanWorkspace,
  type HumanWorkspaceProvider,
} from "../../../sandbox/human-workspace.js";
import { SandboxGoneError, type SandboxHandle } from "../../../sandbox/provider.js";
import type { StageContext, StageHandler, StageOutcome } from "../provider.js";
import { modelCostUsd, pricingFor, type MakerStageDeps, type StageDeps } from "../stage-deps.js";
import { resolveRepositoryTarget } from "../repository-target.js";
import { acquireWorkspaceHandle } from "./attach-workspace.js";
import { makerWorkspaceOf } from "./maker-workspace.js";
import { captureCandidate, gitCredentialInstallerFor, gitCredentialsFor } from "./candidate-capture.js";
import { continues, ends, settleStage, type StageResult } from "./loop-exit.js";
import { resolveRepairSession } from "../session-registry.js";
import { clearSessionProgress, loadSessionProgress } from "./session-progress.js";
import { pollOutcome, pollSession } from "./session-turn.js";
import { makerRouteFor, MakerRouteError } from "../maker-route.js";
import { enforceSpendAndTimeRails } from "../../rails-gate.js";
import { endSession, nowOf, pushIntent, workspaceGone } from "./human-editing-push.js";

export { endSession } from "./human-editing-push.js";

export interface HumanEditingDeps {
  workspaces: HumanWorkspaceProvider;

  pushTokens?: PushTokenIssuer | undefined;

  host?: HostExec | undefined;
  now?: (() => Date) | undefined;
}

export async function makerTurnDestination(
  deps: StageDeps,
  engineeringRunId: string,
  from: "IMPLEMENTING" | "REPAIRING",
  candidateSha: string | null,
  verifying: StageOutcome,
): Promise<StageOutcome> {
  if (!candidateSha) return verifying;

  const pending = await claimPendingTakeover(deps.pool, engineeringRunId, candidateSha);
  if (pending) {
    return {
      kind: "transition",
      to: "HUMAN_EDITING",
      reason: `${pending.githubLogin} took over at a turn boundary; the agent's work is candidate ${candidateSha}`,
    };
  }
  if (from !== "IMPLEMENTING" || !deps.humanEditing) return verifying;
  const run = await getEngineeringRun(deps.pool, engineeringRunId);
  if (!run) return verifying;
  const { mode, pairPrincipalId } = await taskSessionMode(deps.pool, run.taskId);
  if (mode !== "pair" || !pairPrincipalId) return verifying;

  if ((await listHumanSessions(deps.pool, engineeringRunId)).length > 0) return verifying;
  const identity = await principalGithubIdentity(deps.pool, pairPrincipalId);
  if (!identity) return verifying;
  await requestHumanSession(deps.pool, {
    engineeringRunId,
    principalId: pairPrincipalId,
    actor: identity.githubLogin,
    githubUserId: identity.githubUserId,
    githubLogin: identity.githubLogin,
    displayName: identity.displayName,
    origin: "pair",
    requestedFrom: from,
  }).then((session) => updateHumanSession(deps.pool, session.id, { seedSha: candidateSha, state: "provisioning" }));
  return {
    kind: "transition",
    to: "HUMAN_EDITING",
    reason: `Pair mode: the first turn produced candidate ${candidateSha}; ${identity.githubLogin} looks before anything is verified`,
  };
}

export async function makeChangesRequested(deps: StageDeps, engineeringRunId: string): Promise<StageOutcome | null> {
  const live = await liveHumanSession(deps.pool, engineeringRunId);
  if (!live || live.state !== "requested" || live.origin !== "make_changes") return null;
  const { runCandidateShas } = await import("../../human-session.js");
  const shas = await runCandidateShas(deps.pool, engineeringRunId);
  const seed = shas[shas.length - 1];
  if (!seed) {
    await endSession(deps, live, "failed", "the run has no candidate to make changes to");
    return null;
  }
  await updateHumanSession(deps.pool, live.id, { seedSha: seed, state: "provisioning" });
  return {
    kind: "transition",
    to: "HUMAN_EDITING",
    reason: `${live.githubLogin} is making changes to the verified candidate ${seed}`,
  };
}

export function createHumanEditingHandler(deps: StageDeps): StageHandler {
  return {
    state: "HUMAN_EDITING",
    name: "human-editing",
    async handle(context: StageContext): Promise<StageOutcome> {
      const result = await tick(deps, context);
      return settleStage(deps, context.engineeringRunId, result);
    },
  };
}

async function tick(deps: StageDeps, context: StageContext): Promise<StageResult> {
  const { pool } = deps;
  const runId = context.engineeringRunId;
  const session = await liveHumanSession(pool, runId);

  if (await context.isCancellationRequested()) {
    if (session) await endSession(deps, session, "cancelled", null);
    return ends({ kind: "settled", observed: context.state, note: "cancellation observed; the human workspace was deleted" });
  }
  if (!session) {
    return ends({ kind: "transition", to: "BLOCKED", reason: "HUMAN_EDITING with no live human session; nothing to submit or hand back" });
  }
  if (!deps.humanEditing) {
    await endSession(deps, session, "blocked", "this deployment cannot carry a human session (WINDKEEL_TAKEOVER is off or no workspace provider is configured)");
    return ends({ kind: "transition", to: "BLOCKED", reason: "this deployment cannot carry a human session (WINDKEEL_TAKEOVER is off)" });
  }

  const now = nowOf(deps);
  await chargeHumanWorkspace(deps, session);
  const run = await getEngineeringRun(pool, runId);
  if (run?.startedAt) {
    const cap = checkCaps(
      {
        rails: { spend_cap_usd: run.spendCapUsd, wall_clock_cap_seconds: run.wallClockCapSeconds },
        cost: run.cost,
        started_at: run.startedAt,
        parked_seconds: parkedSeconds(await listRunStateTransitions(pool, runId), now),
      },
      now,
    );
    if (cap === "spend_cap") {
      await endSession(deps, session, "cancelled", "the run's spend cap was reached while you were editing");
      return ends({ kind: "transition", to: "CANCELLED", reason: "spend_cap: reached while a person was editing", stopReason: "spend_cap" });
    }
  }

  const since = session.startedAt ?? session.requestedAt;
  if (now.getTime() - since.getTime() > HUMAN_WORKSPACE_MAX_LIFETIME_MS) {
    await endSession(deps, session, "expired", "the human workspace was deleted after 24 hours without a submit or hand back");
    return ends({
      kind: "transition",
      to: "BLOCKED",
      reason: "the human workspace expired after 24 hours without a submit or hand back; uncommitted work is gone",
    });
  }

  switch (session.state) {
    case "requested":
    case "provisioning":
      return provision(deps, session);
    case "ready":
    case "sleeping":
    case "submitting":
    case "handing_back": {
      const intent = session.intent ?? (session.state === "submitting" ? "submit" : session.state === "handing_back" ? "handback" : null);
      if (intent) return pushIntent(deps, session, intent);
      if (session.state === "ready") {
        const idleSince = session.lastActiveAt ?? session.startedAt ?? now;
        if (now.getTime() - idleSince.getTime() > HUMAN_WORKSPACE_IDLE_SLEEP_MS && session.sandboxName) {
          try {
            const handle = await deps.humanEditing.workspaces.attach(session.sandboxName);
            await handle.sleep();
            await updateHumanSession(pool, session.id, { state: "sleeping" });
          } catch (error) {
            if (!(error instanceof SandboxGoneError)) throw error;
            return workspaceGone(deps, session);
          }
        }
      }
      return continues({ kind: "wait", reason: `${session.githubLogin} is editing; waiting for a submit or hand back` });
    }
    default:
      return ends({ kind: "transition", to: "BLOCKED", reason: `the human session is ${session.state}` });
  }
}

async function provision(deps: StageDeps, session: HumanSession): Promise<StageResult> {
  const { pool, config } = deps;
  const runId = session.engineeringRunId;
  if (!session.seedSha) {
    await endSession(deps, session, "failed", "no seed candidate was recorded for the workspace");
    return ends({ kind: "transition", to: "BLOCKED", reason: "the human workspace has no seed candidate" });
  }
  if (session.sandboxName) {

    await deps.humanEditing!.workspaces.attach(session.sandboxName).then((h) => h.destroy()).catch(() => undefined);
  }
  await updateHumanSession(pool, session.id, { state: "provisioning" });
  const target = await resolveRepositoryTarget(pool, runId, config.repository);
  const makerRow = makerWorkspaceOf(await listWorkspaces(pool, runId));
  const baseSha = makerRow?.baseSha && /^[0-9a-f]{40}$/.test(makerRow.baseSha) ? makerRow.baseSha : target.baseRevision;
  const credentials = await gitCredentialsFor(deps, runId);

  try {
    const provisioned = await provisionHumanWorkspace({
      provider: deps.humanEditing!.workspaces,
      repoUrl: target.url,
      baseSha,
      seedSha: session.seedSha,
      gitHost: config.gitHost,
      ...(credentials
        ? {
            readCredential: async () => {
              const minted = await credentials.broker.forWorkspace(`human-${session.id}`, "verifier", credentials.repository);
              return minted;
            },
          }
        : {}),
    });
    await updateHumanSession(pool, session.id, {
      state: "ready",
      baseSha,
      sandboxProvider: deps.humanEditing!.workspaces.name,
      sandboxName: provisioned.handle.name,
      processBaseline: provisioned.baseline,
      installNote: provisioned.installNote,
      startedAt: nowOf(deps),
      lastActiveAt: nowOf(deps),
      error: null,
    });
    return continues({ kind: "wait", reason: `the human workspace is ready for ${session.githubLogin}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await endSession(deps, session, "failed", `the human workspace could not be created: ${message}`);
    return ends({ kind: "transition", to: "BLOCKED", reason: `the human workspace could not be created: ${message}` });
  }
}

async function chargeHumanWorkspace(deps: StageDeps, session: HumanSession): Promise<void> {
  if (!session.sandboxName || session.state === "sleeping" || !deps.humanEditing) return;
  try {
    const handle = await deps.humanEditing.workspaces.attach(session.sandboxName);
    await chargeSandboxUsage(deps.pool, handle as unknown as SandboxHandle, session.id, session.engineeringRunId, {
      usdPerCpuMs: deps.config.usdPerCpuMs,
      usdPerEgressByte: deps.config.usdPerEgressByte,
    });
  } catch (error) {
    if (!(error instanceof SandboxGoneError)) throw error;
  }
}

function handbackTurnText(session: HumanSession, guidance: string | null): string {
  const commit = session.commits[session.commits.length - 1];
  return [
    `${session.githubLogin} took over this run in a workspace of their own and has handed it back to you.`,
    commit
      ? `Their changes are commit ${commit.sha} (on top of your last candidate ${commit.parentSha}); this checkout is now at it. Read what changed with \`git show ${commit.sha}\` before you continue.`
      : "They made no changes; this checkout is where you left it.",
    "Keep their changes unless they break the acceptance criteria. Continue the task, and run the repository's own tests before you finish.",
    ...(guidance ? ["", guidance] : []),
  ].join("\n");
}

export async function resumeAfterHandback(
  deps: MakerStageDeps,
  context: StageContext,
  session: HumanSession,
): Promise<StageResult> {
  const { pool, worker, config } = deps;
  const runId = context.engineeringRunId;

  if (session.resumeAgentRunId) {
    const prior = await getAgentRun(pool, session.resumeAgentRunId);
    if (prior?.completedAt) {
      await clearSessionProgress(pool, prior.id);
      await updateHumanSession(pool, session.id, { resumedAt: new Date() });
      const sha = (prior.result as { candidate?: { candidateSha?: string | null } } | null)?.candidate?.candidateSha ?? null;
      return continues(await makerTurnDestination(deps, runId, "IMPLEMENTING", sha, {
        kind: "transition",
        to: "VERIFYING",
        reason: `the turn after ${session.githubLogin}'s hand back already completed as agent run ${prior.id}`,
      }));
    }
  }

  const workspace = makerWorkspaceOf(await listWorkspaces(pool, runId));
  const handle = workspace ? await acquireWorkspaceHandle(deps, workspace) : undefined;
  if (!workspace || !handle) {
    return ends({
      kind: "transition",
      to: "FAILED",
      reason: "the maker sandbox the hand back resumes in could not be re-acquired (ADR-0017 holds it while HUMAN_EDITING)",
      stopReason: "error",
    });
  }
  const resolved = await resolveRepairSession(deps, runId, handle);
  if (!resolved.held) return ends(resolved.outcome!);
  const held = resolved.held;

  const rails = await enforceSpendAndTimeRails(pool, runId);
  if (rails.stopped) return ends({ kind: "settled", observed: context.state, note: `rails: ${rails.reason}` });
  if (await context.isCancellationRequested()) return ends({ kind: "settled", observed: context.state, note: "cancellation observed" });

  let makerRoute;
  try {
    makerRoute = await makerRouteFor(deps, runId);
    worker.useRoute?.(held.session, makerRoute.route);
  } catch (error) {
    if (!(error instanceof MakerRouteError)) throw error;
    return ends({ kind: "transition", to: "FAILED", reason: error.message, stopReason: "model_policy" });
  }
  const route = makerRoute.route;
  const implementer = (await listAgentRuns(pool, runId)).find((r) => r.role === "implementer");
  const inFlight = session.resumeAgentRunId ? await loadSessionProgress(pool, session.resumeAgentRunId) : null;
  let agentRunId = session.resumeAgentRunId;
  if (!agentRunId || !inFlight) {
    const created = await insertAgentRun(pool, {
      engineeringRunId: runId,
      workerType: implementer?.workerType ?? makerRoute.workerType,
      model: implementer?.model ?? makerRoute.model,
      role: "implementer",
      tokenUsage: null,
    });
    agentRunId = created.id;
    await updateAgentRun(pool, agentRunId, { startedAt: new Date() });
    await updateHumanSession(pool, session.id, { resumeAgentRunId: agentRunId });

    const claimed = await claimPendingGuidance(pool, runId);
    try {
      await worker.send(held.session, { text: handbackTurnText(session, claimed.length ? renderGuidance(claimed) : null) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await updateAgentRun(pool, agentRunId, { completedAt: new Date(), result: { outcome: "failed", error: message, phase: "send" }, modelCost: 0 });
      return ends({ kind: "transition", to: "FAILED", reason: `the turn after the hand back could not be started: ${message}`, stopReason: "error" });
    }
    if (claimed.length) await markGuidanceDelivered(pool, claimed.map((c) => c.id));
  }

  const task = await getEngineeringTask(pool, (await getEngineeringRun(pool, runId))!.taskId);
  const poll = await pollSession(deps, context, held.session, agentRunId);
  if (!poll.finished) return continues(pollOutcome(deps));
  const summary = poll.summary;
  const result = await worker.result(held.session);
  const usd = modelCostUsd(result.usage, pricingFor(implementer?.model ?? makerRoute.model, config.modelPricing));
  await updateAgentRun(pool, agentRunId, { completedAt: new Date(), result: { ...summary, outcome: result.outcome }, tokenUsage: result.usage ?? null, modelCost: usd });
  await clearSessionProgress(pool, agentRunId);
  await recordCost(pool, {
    engineeringRunId: runId,
    stageType: "agent_run",
    stageId: agentRunId,
    kind: "model",
    tokensIn: result.usage?.inputTokens ?? null,
    tokensOut: result.usage?.outputTokens ?? null,
    usd,
    keySource: makerRoute.keySource,
    credentialId: makerRoute.credential?.id ?? null,
    model: implementer?.model ?? makerRoute.model,
  });
  if (summary.stoppedBy || (await context.isCancellationRequested())) {
    return ends({ kind: "settled", observed: context.state, note: `stopped after the hand back: ${summary.stoppedBy ?? "cancellation"}` });
  }
  if (result.outcome !== "completed") {
    return ends({ kind: "transition", to: "FAILED", reason: `the turn after the hand back ${result.outcome}: ${result.error ?? "no reason reported"}`, stopReason: "error" });
  }
  const candidate = await captureCandidate(pool, {
    handle,
    workspace,
    engineeringRunId: runId,
    diff: result.diff,
    modelApiDomain: route.modelApiDomain,
    credentialRules: route.credentialRules,
    task,
    gitHost: config.gitHost,
    authorName: config.gitAuthorName,
    authorEmail: config.gitAuthorEmail,
    installGitCredential: gitCredentialInstallerFor(await gitCredentialsFor(deps, runId), workspace, handle),
    storage: deps.evidence,
    mode: "advance",
  });

  const sha = candidate.candidateSha ?? session.commits[session.commits.length - 1]?.sha ?? null;
  await updateAgentRun(pool, agentRunId, { result: { ...summary, outcome: result.outcome, candidate: { ...candidate, candidateSha: sha } } });
  await updateHumanSession(pool, session.id, { resumedAt: new Date() });
  return continues(await makerTurnDestination(deps, runId, "IMPLEMENTING", sha, {
    kind: "transition",
    to: "VERIFYING",
    reason: `the turn after ${session.githubLogin}'s hand back produced candidate ${sha}`,
  }));
}
