import type { PoolClient } from "pg";
import type { Intent } from "./interpret.js";

export interface ActionContext {
  db: PoolClient;
  repositoryId: string;
  deliveryId: string;
  ignore(reason: string): Promise<void>;
}

export type AfterCommit = () => Promise<void>;

export type ActionResult = AfterCommit | void;

export type AuthorizedCommand = Extract<Intent, { kind: "command" }> & { permission: string };

export interface IngressActions {
  createTask(
    intent: Extract<Intent, { kind: "create_task" }>,
    context: ActionContext,
  ): Promise<ActionResult>;
  cancelRun(
    intent: Extract<Intent, { kind: "cancel_run" }>,
    context: ActionContext,
  ): Promise<ActionResult>;
  command(
    intent: AuthorizedCommand,
    context: ActionContext,
  ): Promise<ActionResult>;
  pullRequestClosed(
    intent: Extract<Intent, { kind: "pr_closed" }>,
    context: ActionContext,
  ): Promise<ActionResult>;
  pullRequestReview(
    intent: Extract<Intent, { kind: "pr_review" }>,
    context: ActionContext,
  ): Promise<ActionResult>;
}

export interface RecordedAction {
  kind: Intent["kind"];
  intent: Intent;
  repositoryId: string;
  deliveryId: string;
}

export function recordingActions(): IngressActions & { recorded: RecordedAction[] } {
  const recorded: RecordedAction[] = [];
  const record = async (intent: Intent, context: ActionContext): Promise<void> => {
    recorded.push({
      kind: intent.kind,
      intent,
      repositoryId: context.repositoryId,
      deliveryId: context.deliveryId,
    });
  };
  return {
    recorded,
    createTask: record,
    cancelRun: record,
    command: record,
    pullRequestClosed: record,
    pullRequestReview: record,
  };
}
