import type { Pool, PoolClient } from "pg";
import type { Criterion } from "@windkeel/verification/evidence/format.js";
import { extractIssueCriteria, needsGeneration, type SourceIssue } from "../factory/criteria-gate.js";
import { hasIntakeGrantRow } from "../factory/stores/repository-store.js";
import {
  type EngineeringRun,
  type EngineeringTask,
  getEngineeringRun,
  getEngineeringTaskBySource,
} from "../factory/repositories.js";
import { taskRepositoryGranted } from "../factory/tenancy.js";
import {
  GITHUB_ISSUE_SOURCE,
  type IntakeDeps,
  type IntakeIssue,
  type IntakeRepository,
  type IntakeResult,
  issueReference,
  riskFromLabels,
  runStartComment,
} from "../factory/issue-intake.js";
import { createTaskFromIntake } from "./create-task.js";
import { isBillingRefusal } from "../billing/admission.js";
import { retriggerExistingTask } from "./relabel.js";

export {
  issueReference,
  riskFromLabels,
  runStartComment,
} from "../factory/issue-intake.js";
export type {
  IntakeGitHub,
  IntakeIssue,
} from "../factory/issue-intake.js";

type Queryable = Pool | PoolClient;

const NOTHING = async (): Promise<void> => {};

export async function createTaskFromIssue(
  deps: IntakeDeps,
  input: { repository: IntakeRepository; issue: IntakeIssue },
): Promise<IntakeResult> {
  const { repository, issue } = input;

  if (issue.state === "closed" || issue.locked === true) {
    const reason = issue.state === "closed" ? "the issue is closed" : "the issue is locked";
    return {
      outcome: { kind: "ignored", reason },
      afterCommit: async () => {
        await deps.github.createIssueComment(
          repository,
          issue.number,
          `Windkeel did not start a run: ${reason}. Reopen the issue and re-apply the \`windkeel\` ` +
            `label to run it.`,
        );
      },
    };
  }

  const reference = issueReference(repository, issue.number);
  const existing = await getEngineeringTaskBySource(
    deps.db,
    repository.id,
    GITHUB_ISSUE_SOURCE,
    reference,
  );

  const criteria = extractIssueCriteria(sourceIssueOf(issue));
  const criteriaRouting = needsGeneration(criteria) ? "pending_generation" : "extracted";

  const granted = existing
    ? await taskRepositoryGranted(deps.db, existing.id)
    : await hasIntakeGrant(deps.db, repository.id);
  if (!granted) {
    return {
      outcome: {
        kind: "ignored",
        reason: existing
          ? `the organization that owns task ${existing.id} no longer holds a grant on ${repository.owner}/${repository.name}`
          : `${repository.owner}/${repository.name} has no intake grant, so a label starts no work (ADR-0024 §2)`,
      },
      afterCommit: NOTHING,
    };
  }

  try {
    if (existing) {
      return await relabel(deps, { repository, issue, task: existing, criteria, criteriaRouting });
    }
    return await createFromIssue(deps, { repository, issue, reference, criteriaRouting });
  } catch (error) {
    if (!isBillingRefusal(error)) throw error;
    const publicReason =
      error.code === "org_budget_exhausted"
        ? "this organization's monthly budget is spent, so no new run starts until an admin raises it or the month ends"
        : error.code === "credits_exhausted"
          ? "this organization is out of credits, so no new run starts until it adds credits or turns on overage"
          : "this organization's billing account is suspended, so no new run starts until billing is resolved";
    return {
      outcome: { kind: "ignored", reason: `${error.code}: ${error.message}` },
      afterCommit: async () => {
        await deps.github.createIssueComment(repository, issue.number, `Windkeel did not start a run: ${publicReason}.`);
      },
    };
  }
}

async function createFromIssue(
  deps: IntakeDeps,
  input: {
    repository: IntakeRepository;
    issue: IntakeIssue;
    reference: string;
    criteriaRouting: "extracted" | "pending_generation";
  },
): Promise<IntakeResult> {
  const { repository, issue, reference, criteriaRouting } = input;

  const created = await createTaskFromIntake(
    deps.db,
    {
      repositoryId: repository.id,
      sourceType: GITHUB_ISSUE_SOURCE,
      sourceReference: reference,
      title: issue.title,
      description: issue.body,
      riskLevel: riskFromLabels(issue.labels, deps.config?.defaultRiskLevel ?? "low"),
      ...(deps.config?.rails ? { rails: deps.config.rails } : {}),
      criteriaSource: { kind: "linked_issue", ref: issue.htmlUrl },
    },
    { startRun: deps.startRun },
  );
  const run = await getEngineeringRun(deps.db, created.runId);
  if (!run) throw new Error(`engineering_run ${created.runId} vanished inside its own transaction`);

  return {
    outcome: {
      kind: "started",
      taskId: created.taskId,
      engineeringRunId: run.id,
      criteria: created.criteria,
      criteriaRouting,
      reusedTask: false,
    },
    afterCommit: startAndAnnounce(deps, repository, issue, run, created.criteria, criteriaRouting),
  };
}

async function hasIntakeGrant(db: Queryable, repositoryId: string): Promise<boolean> {
  return hasIntakeGrantRow(db, repositoryId);
}

async function relabel(
  deps: IntakeDeps,
  input: {
    repository: IntakeRepository;
    issue: IntakeIssue;
    task: EngineeringTask;
    criteria: Criterion[];
    criteriaRouting: "extracted" | "pending_generation";
  },
): Promise<IntakeResult> {
  const { repository, issue, task, criteria, criteriaRouting } = input;

  const outcome = await retriggerExistingTask(deps.db, task, {
    title: issue.title,
    description: issue.body,
    criteria,
    riskLevel: riskFromLabels(issue.labels, deps.config?.defaultRiskLevel ?? task.riskLevel),
    ...(deps.config?.rails ? { rails: deps.config.rails } : {}),
  });

  if (outcome.kind === "already_tasked") {
    return {
      outcome: {
        kind: "noop",
        taskId: task.id,
        engineeringRunId: outcome.run.id,
        reason: `run ${outcome.run.id} is already ${outcome.run.status}`,
      },
      afterCommit: NOTHING,
    };
  }

  return {
    outcome: {
      kind: "started",
      taskId: task.id,
      engineeringRunId: outcome.run.id,
      criteria,
      criteriaRouting,
      reusedTask: true,
    },
    afterCommit: startAndAnnounce(deps, repository, issue, outcome.run, criteria, criteriaRouting),
  };
}

function startAndAnnounce(
  deps: IntakeDeps,
  repository: IntakeRepository,
  issue: IntakeIssue,
  run: EngineeringRun,
  criteria: Criterion[],
  criteriaRouting: "extracted" | "pending_generation",
): () => Promise<void> {
  return async () => {
    await deps.startRun(run.id);
    await deps.github.createIssueComment(
      repository,
      issue.number,
      runStartComment(run, criteria, criteriaRouting),
    );
  };
}

function sourceIssueOf(issue: IntakeIssue): SourceIssue {
  return {
    number: issue.number,
    url: issue.htmlUrl,
    title: issue.title,
    body: issue.body,
  };
}