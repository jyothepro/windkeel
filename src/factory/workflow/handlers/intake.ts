import { defaultHarnessId, registryOf, UNVERSIONED } from "../../../worker/registry.js";
import type { Criterion } from "@windkeel/verification/evidence/format.js";
import {
  approvalExpiredComment,
  decideCriteria,
  type GateDecision,
  type SourceIssue,
} from "../../criteria-gate.js";
import { GITHUB_ISSUE_SOURCE } from "../../issue-intake.js";
import { DEFAULT_APPROVAL_DEADLINE_SECONDS } from "../../rails.js";
import { enforceApprovalDeadline, enforceSpendAndTimeRails } from "../../rails-gate.js";
import {
  type EngineeringTask,
  getEngineeringRun,
  getEngineeringTask,
  updateEngineeringRun,
  updateEngineeringTask,
} from "../../repositories.js";
import { getRepository } from "../../repository-entity.js";
import type { StageContext, StageHandler, StageOutcome } from "../provider.js";
import { modelCostUsd, pricingFor, type StageDeps } from "../stage-deps.js";
import {
  independenceOf,
  ModelPolicyError,
  operatorModelDefaults,
  resolveRunModels,
  type RunModelConfig,
  unwiredCustomerKey,
} from "../../model-policy.js";
import { CheckerKeyError, type CheckerModelsInfo, withCheckerModels } from "../checker-models.js";
import { recordCost } from "../../cost-ledger.js";

function createClassifyingHandler(deps: StageDeps): StageHandler {
  return {
    state: "CREATED",
    name: "intake:classify",
    async handle(context: StageContext): Promise<StageOutcome> {
      const task = await taskOf(deps, context.engineeringRunId);
      return {
        kind: "transition",
        to: "CLASSIFYING",
        reason: `task ${task.id} from ${task.sourceType} ${task.sourceReference}, risk ${task.riskLevel}`,
      };
    },
  };
}

function createPlanningHandler(deps: StageDeps): StageHandler {
  return {
    state: "CLASSIFYING",
    name: "intake:plan",
    async handle(context: StageContext): Promise<StageOutcome> {
      const task = await taskOf(deps, context.engineeringRunId);

      const frozen = await freezeRunModels(deps, context.engineeringRunId, task);
      if ("refused" in frozen) return frozen.refused;
      await updateEngineeringRun(deps.pool, context.engineeringRunId, {
        plan: { generated: false, criteriaProvenance: task.criteriaProvenance },
      });
      return {
        kind: "transition",
        to: "PLANNING",
        reason: "no separate plan; the maker plans" + unpricedNote(frozen.snapshot, deps.config),
      };
    },
  };
}

export function persistedCriteriaOutcome(
  task: Pick<EngineeringTask, "acceptanceCriteria" | "criteriaProvenance" | "criteriaApprovedAt">,
): StageOutcome | null {
  if (task.acceptanceCriteria.length === 0) return null;
  if (task.criteriaProvenance === "generated" && task.criteriaApprovedAt === null) {
    return {
      kind: "transition",
      to: "WAITING_FOR_APPROVAL",
      reason:
        `${task.acceptanceCriteria.length} generated criteria are still unapproved; ` +
        "nothing is provisioned until a human approves (ADR-0012 §4)",
    };
  }
  return {
    kind: "transition",
    to: "PROVISIONING",
    reason:
      task.criteriaProvenance === "generated"
        ? `${task.acceptanceCriteria.length} generated criteria were already approved`
        : `${task.acceptanceCriteria.length} acceptance criteria stated by the author; ` +
          "no generation, no approval pause (ADR-0012 §1)",
  };
}

function createCriteriaGateHandler(deps: StageDeps): StageHandler {
  return {
    state: "PLANNING",
    name: "intake:criteria-gate",
    async handle(context: StageContext): Promise<StageOutcome> {
      const task = await taskOf(deps, context.engineeringRunId);

      const persisted = persistedCriteriaOutcome(task);
      if (persisted) return persisted;

      const issue = await sourceIssueOf(deps, task);
      let decision: GateDecision;
      let checker: CheckerModelsInfo;
      try {
        ({ decision, checker } = await withCheckerModels(deps, context.engineeringRunId, async (models, info) => ({
          decision: await decideCriteria(issue, models, {
            deadlineSeconds: deps.config.approvalDeadlineSeconds ?? DEFAULT_APPROVAL_DEADLINE_SECONDS,
          }),
          checker: info,
        })));
      } catch (error) {
        if (error instanceof CheckerKeyError) {
          return { kind: "transition", to: "FAILED", reason: error.message, stopReason: error.stopReason };
        }
        return {
          kind: "transition",
          to: "FAILED",
          reason:
            `acceptance criteria could not be generated independently of the maker: ` +
            `${error instanceof Error ? error.message : String(error)} (ADR-0010 §3)`,
          stopReason: "error",
        };
      }

      if (decision.kind !== "proceed") {
        await recordCriteriaCost(deps, context.engineeringRunId, decision.usage, checker);
      }

      if (decision.kind === "cancel") {
        await comment(deps, task, decision.comment);
        return { kind: "transition", to: "CANCELLED", reason: decision.reason };
      }

      if (decision.kind === "proceed") {
        await persistCriteria(deps, task, decision.criteria, null);
        return { kind: "transition", to: "PROVISIONING", reason: "criteria extracted late" };
      }

      await persistCriteria(
        deps,
        task,
        decision.criteria,
        `${decision.generatedBy.vendor}/${decision.generatedBy.model}`,
      );
      await comment(deps, task, decision.comment);
      return {
        kind: "transition",
        to: "WAITING_FOR_APPROVAL",
        reason:
          `${decision.criteria.length} criteria generated by ` +
          `${decision.generatedBy.vendor}/${decision.generatedBy.model}; ` +
          "nothing is provisioned until a human approves (ADR-0012 §4)",
      };
    },
  };
}

function createApprovalGateHandler(deps: StageDeps): StageHandler {
  return {
    state: "WAITING_FOR_APPROVAL",
    name: "intake:approval",
    async handle(context: StageContext): Promise<StageOutcome> {
      const rails = await enforceSpendAndTimeRails(deps.pool, context.engineeringRunId);
      if (rails.stopped) {
        return { kind: "settled", observed: context.state, note: `rails: ${rails.reason}` };
      }
      if (await context.isCancellationRequested()) {
        return { kind: "settled", observed: context.state, note: "cancellation observed" };
      }

      const deadlineSeconds = deps.config.approvalDeadlineSeconds ?? DEFAULT_APPROVAL_DEADLINE_SECONDS;
      const gate = await enforceApprovalDeadline(
        deps.pool,
        context.engineeringRunId,
        deadlineSeconds,
      );
      if (gate.stopped) {
        await comment(deps, await taskOf(deps, context.engineeringRunId), approvalExpiredComment(deadlineSeconds));
        return { kind: "settled", observed: context.state, note: `gate: ${gate.reason}` };
      }

      const signals = await context.takeSignals();
      const approval = signals.find((s) => s.signal.type === "approval_granted");
      const denial = signals.find((s) => s.signal.type === "approval_denied");

      if (denial && denial.signal.type === "approval_denied") {
        const task = await taskOf(deps, context.engineeringRunId);
        await comment(
          deps,
          task,
          `**Run cancelled.** ${denial.signal.actor} declined the generated acceptance criteria` +
            `${denial.signal.reason ? `: ${denial.signal.reason}` : "."}`,
        );
        return {
          kind: "transition",
          to: "CANCELLED",
          reason: `criteria declined by ${denial.signal.actor}`,
        };
      }

      if (!approval || approval.signal.type !== "approval_granted") {
        return { kind: "wait", reason: "no approval yet" };
      }

      const task = await taskOf(deps, context.engineeringRunId);
      await updateEngineeringTask(deps.pool, task.id, {
        criteriaApprovedAt: approval.receivedAt,
        criteriaApprovedBy: approval.signal.actor,
      });
      return {
        kind: "transition",
        to: "PROVISIONING",
        reason: `criteria approved by ${approval.signal.actor}`,
      };
    },
  };
}

export function createIntakeHandlers(deps: StageDeps): StageHandler[] {
  return [
    createClassifyingHandler(deps),
    createPlanningHandler(deps),
    createCriteriaGateHandler(deps),
    createApprovalGateHandler(deps),
  ];
}

async function freezeRunModels(
  deps: StageDeps,
  engineeringRunId: string,
  task: EngineeringTask,
): Promise<{ snapshot: RunModelConfig } | { refused: StageOutcome }> {
  const run = await getEngineeringRun(deps.pool, engineeringRunId);
  let snapshot = run?.modelConfig ?? null;
  if (!snapshot) {
    try {
      snapshot = await resolveRunModels(deps.pool, {
        organizationId: task.organizationId,
        repositoryId: task.repositoryId,
        taskOverride: task.modelOverride,
        runOverride: run?.modelOverride ?? null,
        operatorDefaults: operatorModelDefaults(deps.config),
        ...intakeHarnesses(deps),
      });
    } catch (error) {
      if (!(error instanceof ModelPolicyError)) throw error;
      return { refused: modelRefusal(`the run's models could not be resolved: ${error.message}`) };
    }
    await updateEngineeringRun(deps.pool, engineeringRunId, {
      modelConfig: snapshot,
      selectedModel: snapshot.maker.model,
      ...(snapshot.maker.worker ? { selectedWorker: snapshot.maker.worker } : {}),
    });
  }
  const dependent = independenceOf(snapshot);
  if (dependent) return { refused: modelRefusal(dependent) };
  const unwired = unwiredCustomerKey(snapshot);
  if (unwired) return { refused: modelRefusal(unwired) };
  return { snapshot };
}

function intakeHarnesses(
  deps: StageDeps,
): { harnesses: { versions: Record<string, string>; defaultId: string } } | { worker: string } | Record<string, never> {
  const legacy = (deps as { worker?: { name: string } }).worker;
  if (!deps.workers) return legacy ? { worker: legacy.name } : {};
  const versions: Record<string, string> = {};
  for (const [id, adapter] of registryOf(deps)) versions[id] = adapter.version ?? UNVERSIONED;
  return { harnesses: { versions, defaultId: defaultHarnessId(deps.workers, deps.defaultHarness) } };
}

function unpricedNote(snapshot: RunModelConfig, config: StageDeps["config"]): string {
  const unpriced = [
    ...(pricingFor(snapshot.maker.model, config.modelPricing) ? [] : [`maker ${snapshot.maker.model}`]),
    ...snapshot.checker
      .filter((choice) => !pricingFor(choice.model, config.checkerPricing))
      .map((choice) => `checker ${choice.model}`),
  ];
  if (unpriced.length === 0) return "";
  return (
    `; ${unpriced.join(", ")} ${unpriced.length === 1 ? "has" : "have"} no catalog price and no ` +
    "WINDKEEL_*USD_PER_* pin — cost is recorded unpriced, and the spend cap counts those tokens at the " +
    "conservative estimate (ADR-0026 §9, #324)"
  );
}

async function recordCriteriaCost(
  deps: StageDeps,
  engineeringRunId: string,
  usage: { inputTokens: number; outputTokens: number } | undefined,
  checker: CheckerModelsInfo,
): Promise<void> {
  await recordCost(deps.pool, {
    engineeringRunId,
    stageType: "criteria",
    stageId: engineeringRunId,
    kind: "model",
    ...(usage ? { tokensIn: usage.inputTokens, tokensOut: usage.outputTokens } : {}),
    usd: modelCostUsd(usage, pricingFor(checker.model, deps.config.checkerPricing)),
    keySource: checker.keySource,
    credentialId: checker.credentialId ?? null,
    model: checker.model,
  });
}

function modelRefusal(reason: string): StageOutcome {
  return { kind: "transition", to: "FAILED", reason, stopReason: "model_policy" };
}

async function taskOf(deps: StageDeps, engineeringRunId: string): Promise<EngineeringTask> {
  const run = await getEngineeringRun(deps.pool, engineeringRunId);
  if (!run) throw new Error(`intake: engineering_run ${engineeringRunId} not found`);
  const task = await getEngineeringTask(deps.pool, run.taskId);
  if (!task) throw new Error(`intake: engineering_task for run ${engineeringRunId} not found`);
  return task;
}

async function persistCriteria(
  deps: StageDeps,
  task: EngineeringTask,
  criteria: Criterion[],
  generatedBy: string | null,
): Promise<void> {
  await updateEngineeringTask(deps.pool, task.id, {
    acceptanceCriteria: criteria,
    criteriaProvenance: generatedBy ? "generated" : "extracted",
    criteriaGeneratedBy: generatedBy,
    criteriaApprovedAt: null,
    criteriaApprovedBy: null,
  });
}

async function sourceIssueOf(deps: StageDeps, task: EngineeringTask): Promise<SourceIssue> {
  const number = issueNumberOf(task);
  const url = await issueUrlOf(deps, task, number);
  return { number: number ?? 0, url, title: task.title, body: task.description };
}

export function issueNumberOf(task: EngineeringTask): number | null {
  if (task.sourceType !== GITHUB_ISSUE_SOURCE) return null;
  const match = /#(\d+)$/.exec(task.sourceReference);
  return match?.[1] ? Number(match[1]) : null;
}

async function issueUrlOf(
  deps: StageDeps,
  task: EngineeringTask,
  number: number | null,
): Promise<string> {
  if (number === null) return `windkeel:task/${task.id}`;
  const repository = await getRepository(deps.pool, task.repositoryId);
  if (!repository) return `windkeel:task/${task.id}`;
  return `https://github.com/${repository.owner}/${repository.name}/issues/${number}`;
}

async function comment(deps: StageDeps, task: EngineeringTask, body: string): Promise<void> {
  const number = issueNumberOf(task);
  if (number === null || !deps.github) return;
  const repository = await getRepository(deps.pool, task.repositoryId);
  if (!repository) return;
  await deps.github.createIssueComment(
    { owner: repository.owner, name: repository.name },
    number,
    body,
  );
}
