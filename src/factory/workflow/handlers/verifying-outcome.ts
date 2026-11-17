
import type { RepairPacket } from "@windkeel/verification/engine/repair.js";
import type { VerificationResult } from "@windkeel/verification/engine/types.js";
import { recordCost } from "../../cost-ledger.js";
import { recordRunAuditEvent, SYSTEM_ACTOR, withTransaction } from "../../audit-log.js";
import { sealEvidenceReference } from "../../evidence-storage.js";
import { evidenceItemsFromPackage } from "../../stage-results.js";
import { enforceRepairLoopRails } from "../rails-gate.js";
import {
  getEngineeringRun,
  getEngineeringTask,
  insertRepairAttempt,
  listVerificationRuns,
  listWorkspaces,
  updateEngineeringRun,
  updateVerificationRun,
  type VerificationRun,
} from "../../repositories.js";
import type { DependencyInstall } from "../../../sandbox/dependencies.js";
import type { ToolInstall } from "../../../sandbox/system-tools.js";
import type { StageContext } from "../provider.js";
import { modelCostUsd, pricingFor, type StageDeps } from "../stage-deps.js";
import { listHumanSessions } from "../../human-session.js";
import { makerWorkspaceOf } from "./maker-workspace.js";
import type { ProvisionedEnvironment } from "../../workspace-service.js";
import { type CheckerModelsInfo } from "../checker-models.js";
import { continues, ends, type StageResult } from "./loop-exit.js";

export async function persist(
  deps: StageDeps,
  engineeringRunId: string,
  verificationRun: VerificationRun,
  result: VerificationResult,
  packageDir: string,

  dependencies?: DependencyInstall,

  tools?: ToolInstall[],

  checker: CheckerModelsInfo = { keySource: "orqon", model: null },

  environment?: ProvisionedEnvironment,
): Promise<void> {
  const { pool } = deps;

  await withTransaction(pool, async (tx) => {
    await updateVerificationRun(tx, verificationRun.id, {
      verdict: result.verdict,
      riskSummary: {
        blocking: result.computation.blocking,
        unsatisfied: result.computation.unsatisfied,
        nonBlocking: result.computation.nonBlocking,
        satisfied: result.computation.satisfied,
        signed: result.signature.signed,

        ...(result.incomplete.length ? { incomplete: result.incomplete } : {}),

        evidence: evidenceItemsFromPackage(packageDir),
        ...(dependencies ? { dependencies } : {}),
        ...(tools?.length ? { tools } : {}),
        ...(environment
          ? {
              environment: {
                mode: environment.mode,
                snapshotId: environment.snapshotId ?? null,
                snapshotKey: environment.snapshotKey ?? null,
                ...(environment.installInputChanges !== undefined ? { installInputChanges: environment.installInputChanges } : {}),
                ...(environment.services ? { services: environment.services } : {}),
                ...(environment.fallback ? { fallback: environment.fallback } : {}),
              },
            }
          : {}),
      },
      completedAt: new Date(),
    });
    await recordRunAuditEvent(tx, engineeringRunId, {
      actor: SYSTEM_ACTOR,
      action: result.verdict === "fail" ? "run.verification_failed" : "run.verified",
      detail: {
        verificationRunId: verificationRun.id,
        candidateSha: verificationRun.candidateSha,
        verdict: result.verdict,
        signed: result.signature.signed,
        blocking: result.computation.blocking.length,
      },
    });
  });

  if (deps.evidence) {
    await sealEvidenceReference(
      pool,
      deps.evidence.storage,
      verificationRun.id,
      engineeringRunId,
      packageDir,
      deps.evidence.bucket,
    );
  }

  const checkerUsage = result.checkerUsage;
  await recordCost(pool, {
    engineeringRunId,
    stageType: "verification_run",
    stageId: verificationRun.id,
    kind: "model",
    ...(checkerUsage
      ? { tokensIn: checkerUsage.inputTokens, tokensOut: checkerUsage.outputTokens }
      : {}),
    usd: modelCostUsd(checkerUsage, pricingFor(checker.model, deps.config.checkerPricing)),
    keySource: checker.keySource,
    credentialId: checker.credentialId ?? null,
    model: checker.model,
  });

  if (result.repair) {
    const attemptNumber = (await listVerificationRuns(pool, engineeringRunId)).length;
    await insertRepairAttempt(pool, {
      engineeringRunId,
      verificationRunId: verificationRun.id,
      attemptNumber,
      repairPacket: result.repair,
    });
  }

  await updateEngineeringRun(pool, engineeringRunId, { finalVerdict: result.verdict });
}

export async function outcomeFor(
  deps: StageDeps,
  context: StageContext,
  verdict: VerificationRun["verdict"],
  verificationRunId: string,

  repair?: RepairPacket | null,
): Promise<StageResult> {
  if (verdict === "pass" || verdict === "warn") {
    return ends({
      kind: "transition",
      to: "PR_CREATING",
      reason: `verification ${verificationRunId} verdict ${verdict}`,
    });
  }

  const couldNotRun = repair?.checks_could_not_run ?? [];
  if (couldNotRun.length) {
    const named = couldNotRun.map((c) => `\`${c.check}\` (${c.detail})`).join("; ");
    return ends({
      kind: "transition",
      to: "FAILED",
      reason:
        `verification ${verificationRunId} could not run ${couldNotRun.length} declared ` +
        `check${couldNotRun.length === 1 ? "" : "s"}: ${named}. The candidate was not judged, ` +
        "so there is nothing for a repairer to fix — repairing the repository cannot make a " +
        "command the verifier does not have exit 0. Install or declare the command, then " +
        "start a new run (ADR-0003: terminal states are not re-entered).",
      stopReason: "error",
    });
  }

  const sessions = await listHumanSessions(deps.pool, context.engineeringRunId);
  const lastSession = sessions[sessions.length - 1];
  if (
    lastSession?.origin === "make_changes" &&
    lastSession.outcome === "submitted" &&
    !makerWorkspaceOf(await listWorkspaces(deps.pool, context.engineeringRunId))
  ) {
    return ends({
      kind: "transition",
      to: "BLOCKED",
      reason:
        `verification ${verificationRunId} verdict fail on ${lastSession.githubLogin}'s changes to the ` +
        "verified pull request. There is no agent session to repair them: the maker ended when the " +
        "pull request opened, and a repair turn is a resumed one (ADR-0011 §2, ADR-0017 §3). The " +
        "failing candidate is on the pull request's branch; the evidence says what failed.",
    });
  }

  const run = await getEngineeringRun(deps.pool, context.engineeringRunId);
  const task = run ? await getEngineeringTask(deps.pool, run.taskId) : null;
  const rails = await enforceRepairLoopRails(
    deps.pool,
    context.engineeringRunId,
    task?.riskLevel ?? "high",
  );
  if (rails.stopped) {
    return ends({ kind: "settled", observed: context.state, note: `rails: ${rails.reason}` });
  }

  return continues({
    kind: "transition",
    to: "REPAIRING",
    reason:
      `verification ${verificationRunId} verdict fail with repair budget remaining; the ` +
      "RepairPacket is persisted and the maker workspace and worker session are held for the " +
      "repair turn (ADR-0017)",
  });
}
