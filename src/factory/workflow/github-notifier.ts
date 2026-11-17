import type { Pool } from "pg";
import type { GitHubClient } from "../../github/client.js";
import { fenced } from "../../github/summary.js";
import { defaultLog, describeError, type IntakeLog } from "../log.js";
import { registerSourceNotifier, type RunOutcome, type SourceNotifier } from "../../intake/notifiers.js";
import { GITHUB_ISSUE_SOURCE } from "../issue-intake.js";
import type { EngineeringRun, EngineeringTask } from "../repositories.js";
import { getRepository } from "../repository-entity.js";
import type { RunState } from "../run-state-machine.js";
import { issueNumberOf } from "./branch.js";

const GITHUB_NOTIFIED_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "FAILED",
  "MAX_REPAIR_ATTEMPTS_REACHED",
  "BLOCKED",
]);

export function outcomeMarker(transitionId: string): string {
  return `<!-- windkeel:outcome:${transitionId} -->`;
}

const HEADLINE: Partial<Record<RunState, string>> = {
  FAILED: "failed",
  MAX_REPAIR_ATTEMPTS_REACHED: "stopped: its repair attempts ran out",
  BLOCKED: "is blocked and needs a person",
};

const NEXT_STEP: Partial<Record<RunState, string>> = {
  FAILED: "Remove and re-add the `windkeel` label to start a fresh run once the cause is addressed.",
  MAX_REPAIR_ATTEMPTS_REACHED:
    "The candidate still failed verification after the last repair. Remove and re-add the " +
    "`windkeel` label to start a fresh run.",
  BLOCKED: "It holds its place until someone acts. Comment `/windkeel cancel` or remove the `windkeel` label to stop it.",
};

export function outcomeComment(runId: string, outcome: Pick<RunOutcome, "state" | "reason" | "transitionId">): string {
  const lines = [
    `**Run \`${runId}\` ${HEADLINE[outcome.state] ?? `ended ${outcome.state}`}.**`,
    "",
  ];
  if (outcome.reason?.trim()) lines.push(fenced(outcome.reason.trim()), "");
  lines.push(NEXT_STEP[outcome.state] ?? "", "", outcomeMarker(outcome.transitionId));
  return lines.join("\n");
}

export interface GitHubNotifierDeps {
  pool: Pool;
  github: GitHubClient;
  log?: IntakeLog;
}

export function createGitHubNotifier(deps: GitHubNotifierDeps): SourceNotifier {
  const log = deps.log ?? defaultLog;
  return {
    sourceType: GITHUB_ISSUE_SOURCE,
    async notify(task: EngineeringTask, run: EngineeringRun, outcome: RunOutcome): Promise<void> {
      if (outcome.kind !== "state" || !GITHUB_NOTIFIED_STATES.has(outcome.state)) return;
      const number = issueNumberOf(task);
      if (number === null) return;
      try {
        const repository = await getRepository(deps.pool, task.repositoryId);
        if (!repository) return;
        const ref = { owner: repository.owner, name: repository.name };
        const marker = outcomeMarker(outcome.transitionId);
        const existing = await deps.github.listIssueComments(ref, number);
        if (existing.some((comment) => comment.body.includes(marker))) return;
        await deps.github.createIssueComment(ref, number, outcomeComment(run.id, outcome));
      } catch (error) {
        log("github outcome comment failed", {
          engineeringRunId: run.id,
          state: outcome.state,
          transitionId: outcome.transitionId,
          ...describeError(error),
        });
      }
    },
  };
}

export function registerGitHubNotifier(deps: GitHubNotifierDeps): void {
  registerSourceNotifier(createGitHubNotifier(deps));
}
