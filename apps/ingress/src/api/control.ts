import type { Pool } from "pg";
import { applyIssueCommand, type RunControl } from "@windkeel/factory/runs";
import { listGuidance, recordGuidance } from "@windkeel/factory/runs";
import { getEngineeringRun, getEngineeringTask } from "@windkeel/factory/repositories";
import { getRepository } from "@windkeel/factory/repositories";
import type { RunCommandPort } from "./handlers.js";

export const GITHUB_ISSUE_SOURCE = "github_issue";

export interface ControlDeps {
  pool: Pool;
  control: RunControl & { startRun(engineeringRunId: string): Promise<{ enqueued: boolean }> };
  github: Parameters<typeof applyIssueCommand>[0]["github"];
}

export function apiControl(deps: ControlDeps): RunCommandPort {
  return {
    async approve(engineeringRunId, actor) {
      const viaIssue = await issueCommand(deps, engineeringRunId, "approve", actor);
      if (viaIssue.outcome !== "no_issue_source") return viaIssue;
      await deps.control.signal(engineeringRunId, { type: "approval_granted", actor });
      return { outcome: "approved" };
    },

    async cancel(engineeringRunId, reason, actor) {
      const viaIssue = await issueCommand(deps, engineeringRunId, "cancel", actor);
      if (viaIssue.outcome !== "no_issue_source") return viaIssue;
      await deps.control.cancel(engineeringRunId, reason);
      return { outcome: "cancelled" };
    },

    async message(engineeringRunId, message, actor, actorPrincipalId) {
      await recordGuidance(deps.pool, { engineeringRunId, actor, actorPrincipalId, message });
      return { outcome: "queued" };
    },

    async wake(engineeringRunId, intent, actor) {
      await deps.control.signal(engineeringRunId, { type: "human_intent", intent, actor });
    },

    async listMessages(engineeringRunId, runState) {
      return listGuidance(deps.pool, engineeringRunId, runState);
    },

    async startRun(taskId, _actor, rails, modelOverride) {
      const { startNewRun } = await import("@windkeel/factory/runs");
      const run = await startNewRun(deps.pool, taskId, { ...(rails ?? {}), ...(modelOverride ? { modelOverride } : {}) });
      return { engineeringRunId: run.id };
    },

    async enqueue(engineeringRunId) {
      return deps.control.startRun(engineeringRunId);
    },
  };
}

async function issueCommand(
  deps: ControlDeps,
  engineeringRunId: string,
  command: "approve" | "cancel",
  actor: string,
): Promise<{ outcome: string; reason?: string }> {
  const run = await getEngineeringRun(deps.pool, engineeringRunId);
  if (!run) return { outcome: "ignored", reason: "no such run" };
  const task = await getEngineeringTask(deps.pool, run.taskId);
  if (!task || task.sourceType !== GITHUB_ISSUE_SOURCE) {
    return { outcome: "no_issue_source" };
  }
  const repository = await getRepository(deps.pool, task.repositoryId);
  if (!repository) return { outcome: "ignored", reason: "task has no repository" };

  const issueNumber = Number(task.sourceReference.split("#").pop());
  if (!Number.isInteger(issueNumber)) {
    return { outcome: "ignored", reason: "task source reference is not an issue" };
  }

  const result = await applyIssueCommand(
    { db: deps.pool, github: deps.github, control: deps.control },
    {
      command,
      repository: { id: repository.id, owner: repository.owner, name: repository.name },
      issueNumber,
      actor,
      authority: { via: "api" },
    },
  );
  await result.afterCommit();
  return result.outcome.kind === "refused" || result.outcome.kind === "ignored"
    ? { outcome: result.outcome.kind, reason: result.outcome.reason }
    : { outcome: result.outcome.kind };
}
