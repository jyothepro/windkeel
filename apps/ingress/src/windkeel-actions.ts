

import { recordDelivery } from "@windkeel/factory/intake";
import {
  createTaskFromIssue,
  type IntakeGitHub,
  type IntakeIssue,
} from "@windkeel/factory/runs";
import {
  applyIssueCommand,
  cancelRunForIssue,
  type RunControl,
} from "@windkeel/factory/runs";
import {
  applyPullRequestClosed,
  type PullRequestSignaller,
} from "@windkeel/factory/runs";
import { suggestFromReview } from "@windkeel/factory/repositories";
import { VercelWorkflowProvider } from "@windkeel/factory/workflow";
import {
  resolveWorkflowBacking,
  type WorkflowBacking,
} from "@windkeel/factory/workflow";
import type { WorkflowProvider } from "@windkeel/factory/workflow";
import type { ActionContext, ActionResult, AuthorizedCommand, IngressActions } from "./actions.js";
import { GITHUB_INTAKE_SOURCE } from "./handler.js";
import type { Intent } from "./interpret.js";

export interface RunEnqueuer extends RunControl, PullRequestSignaller {
  startRun(engineeringRunId: string): Promise<{ enqueued: boolean }>;
  stop(): Promise<void>;

  readonly backing?: WorkflowBacking;
}

export interface EnqueuerConfig {
  connectionString: string;
  applicationSchema?: string;

  backing?: WorkflowBacking;
}

export function runEnqueuer(config: EnqueuerConfig): RunEnqueuer {
  const backing = config.backing ?? resolveWorkflowBacking().backing;
  let provider: WorkflowProvider | null = null;
  let starting: Promise<WorkflowProvider> | null = null;

  const ready = async (): Promise<WorkflowProvider> => {
    if (provider) return provider;
    starting ??= (async () => {
      const created: WorkflowProvider = new VercelWorkflowProvider({
        connectionString: config.connectionString,
        ...(config.applicationSchema ? { applicationSchema: config.applicationSchema } : {}),
      });

      await created.start();
      provider = created;
      return created;
    })();
    return starting;
  };

  return {
    backing,
    async startRun(engineeringRunId) {
      const result = await (await ready()).startRun(engineeringRunId);
      return { enqueued: result.enqueued };
    },
    async signal(engineeringRunId, signal) {
      return (await ready()).signal(engineeringRunId, signal);
    },
    async cancel(engineeringRunId, reason) {
      return (await ready()).cancel(engineeringRunId, reason);
    },
    async stop() {
      await provider?.stop();
      provider = null;
      starting = null;
    },
  };
}

export interface WindkeelActionsDeps {
  github: IntakeGitHub;
  enqueue: RunEnqueuer;

  intake?: Parameters<typeof createTaskFromIssue>[0]["config"];
}

function recordIntent(context: ActionContext, note: string, taskId?: string): Promise<void> {
  return recordDelivery(context.db, GITHUB_INTAKE_SOURCE, context.deliveryId, {
    intent: note,
    ...(taskId ? { engineeringTaskId: taskId } : {}),
  });
}

export function windkeelActions(deps: WindkeelActionsDeps): IngressActions {
  return {
    async createTask(
      intent: Extract<Intent, { kind: "create_task" }>,
      context: ActionContext,
    ): Promise<ActionResult> {
      const issue: IntakeIssue = {
        number: intent.issue.number,
        title: intent.issue.title,
        body: intent.issue.body,
        labels: intent.issue.labels,
        htmlUrl: intent.issue.htmlUrl,
        state: intent.issue.state,
        locked: intent.issue.locked,
      };
      const result = await createTaskFromIssue(
        {
          db: context.db,
          github: deps.github,
          startRun: (runId) => deps.enqueue.startRun(runId),
          ...(deps.intake ? { config: deps.intake } : {}),
        },
        {
          repository: {
            id: context.repositoryId,
            owner: intent.repository.owner,
            name: intent.repository.name,
          },
          issue,
        },
      );

      if (result.outcome.kind === "ignored") {

        await context.ignore(result.outcome.reason);
        return result.afterCommit;
      }

      await recordIntent(context, `create_task:${result.outcome.kind}`, result.outcome.taskId);
      return result.afterCommit;
    },

    async cancelRun(
      intent: Extract<Intent, { kind: "cancel_run" }>,
      context: ActionContext,
    ): Promise<ActionResult> {

      const result = await cancelRunForIssue(
        { db: context.db, github: deps.github, control: deps.enqueue },
        {
          repository: {
            id: context.repositoryId,
            owner: intent.repository.owner,
            name: intent.repository.name,
          },
          issueNumber: intent.issueNumber,
          actor: intent.actor,
        },
      );
      await recordIntent(context, `cancel_run:${result.outcome.kind}`);
      return result.afterCommit;
    },

    async command(
      intent: AuthorizedCommand,
      context: ActionContext,
    ): Promise<ActionResult> {
      const result = await applyIssueCommand(
        { db: context.db, github: deps.github, control: deps.enqueue },
        {
          repository: {
            id: context.repositoryId,
            owner: intent.repository.owner,
            name: intent.repository.name,
          },
          issueNumber: intent.issueNumber,
          command: intent.command,
          actor: intent.actor,
          authority: { via: "github_permission", permission: intent.permission },
        },
      );
      await recordIntent(context, `command:${intent.command}:${result.outcome.kind}`);
      return result.afterCommit;
    },

    async pullRequestClosed(
      intent: Extract<Intent, { kind: "pr_closed" }>,
      context: ActionContext,
    ): Promise<ActionResult> {

      const result = await applyPullRequestClosed(
        { db: context.db, control: deps.enqueue },
        {
          repositoryId: context.repositoryId,
          pullNumber: intent.pullNumber,
          merged: intent.merged,
          ...(intent.sender ? { sender: intent.sender } : {}),
        },
      );
      await recordIntent(context, `pr_closed:${result.outcome.kind}`);
      return result.afterCommit;
    },

    async pullRequestReview(
      intent: Extract<Intent, { kind: "pr_review" }>,
      context: ActionContext,
    ): Promise<ActionResult> {

      const outcome = await suggestFromReview(context.db, {
        repositoryId: context.repositoryId,
        pullNumber: intent.pullNumber,
        deliveryId: context.deliveryId,
        feedback: intent.feedback,
      });
      if (outcome.kind === "ignored") {
        await context.ignore(outcome.reason);
        return;
      }
      await recordIntent(context, "pr_review:suggested");
    },
  };
}
