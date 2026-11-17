import type { Pool, PoolClient } from "pg";
import {
  IntakeRejection,
  runIntake,
  type IntakeSource,
  type RawRequest,
} from "@windkeel/factory/intake";
import { upsertRepository } from "@windkeel/factory/repositories";
import {
  authorizeCommenter,
  authorizeLabeler,
  type CommenterPermissionLookup,
} from "@windkeel/factory/runs";
import type { AfterCommit, AuthorizedCommand, IngressActions } from "./actions.js";
import { type Intent, interpret } from "./interpret.js";
import { SIGNATURE_HEADER, verifyWebhookSignature } from "./signature.js";

export const EVENT_HEADER = "x-github-event";
export const DELIVERY_HEADER = "x-github-delivery";

export const GITHUB_INTAKE_SOURCE = "github";

export type WebhookRequest = RawRequest;

export interface WebhookResponse {
  status: number;
  body: {
    ok: boolean;
    intent?: string;
    reason?: string;
    duplicate?: boolean;
    error?: string;
  };
}

export interface HandlerDeps {
  secret: string;
  pool: Pool;
  actions: IngressActions;
  permissions?: CommenterPermissionLookup | undefined;
}

export function githubIntakeSource(deps: {
  secret: string;
  actions: IngressActions;
  permissions?: CommenterPermissionLookup | undefined;
}): IntakeSource<unknown> {
  return {
    name: GITHUB_INTAKE_SOURCE,

    async verify(req) {
      if (!req.headers[EVENT_HEADER] || !req.headers[DELIVERY_HEADER]) {
        return { ok: false, status: 400, error: "missing X-GitHub-Event or X-GitHub-Delivery" };
      }
      if (!verifyWebhookSignature(deps.secret, req.rawBody, req.headers[SIGNATURE_HEADER])) {
        return { ok: false, status: 401, error: "signature verification failed" };
      }
      return { ok: true };
    },

    parse(req) {
      try {
        return JSON.parse(
          typeof req.rawBody === "string" ? req.rawBody : req.rawBody.toString("utf8"),
        ) as unknown;
      } catch {
        throw new IntakeRejection("body is not valid JSON");
      }
    },

    deliveryKey(req) {
      return req.headers[DELIVERY_HEADER] ?? "";
    },

    async interpret(payload, ctx) {
      const event = ctx.req.headers[EVENT_HEADER] ?? "";
      const action = (payload as { action?: string } | null)?.action ?? null;
      const intent = interpret(event, payload);
      if (intent.kind === "ignore") {
        return { kind: "ignore", reason: intent.reason, event, action };
      }
      if (intent.kind === "command") {
        const authorization = await authorizeCommenter(deps.permissions, {
          repository: { owner: intent.repository.owner, name: intent.repository.name },
          actor: intent.actor,
          authorAssociation: intent.authorAssociation,
        });
        if (!authorization.ok) {
          return {
            kind: "ignore",
            reason: `/windkeel ${intent.command} refused: ${authorization.reason}`,
            event,
            action,
          };
        }
        const authorized: AuthorizedCommand = { ...intent, permission: authorization.permission };
        return {
          kind: "act",
          intent: intent.kind,
          event,
          action,
          act: (tx) => dispatch(deps.actions, authorized, tx),
        };
      }
      if (intent.kind === "create_task" || intent.kind === "cancel_run") {
        const authorization = await authorizeLabeler(deps.permissions, {
          repository: { owner: intent.repository.owner, name: intent.repository.name },
          actor: intent.actor,
        });
        if (!authorization.ok) {
          const verb = intent.kind === "create_task" ? "adding" : "removing";
          return {
            kind: "ignore",
            reason: `${verb} the windkeel label refused: ${authorization.reason}`,
            event,
            action,
          };
        }
      }
      return {
        kind: "act",
        intent: intent.kind,
        event,
        action,
        act: (tx) => dispatch(deps.actions, intent, tx),
      };
    },
  };
}

export async function handleWebhook(
  request: WebhookRequest,
  deps: HandlerDeps,
): Promise<WebhookResponse> {
  return runIntake(githubIntakeSource(deps), request, {
    pool: deps.pool,
    transientStatus: 500,
  });
}

async function dispatch(
  actions: IngressActions,
  intent: Exclude<Intent, { kind: "ignore" | "command" }> | AuthorizedCommand,
  tx: { db: PoolClient; deliveryKey: string; ignore(reason: string): Promise<void> },
): Promise<AfterCommit | void> {
  const db = tx.db;
  const repository = await upsertRepository(db, {
    owner: intent.repository.owner,
    name: intent.repository.name,
    defaultBranch: intent.repository.defaultBranch,
    cloneUrl: intent.repository.cloneUrl,
    githubInstallationId: intent.repository.installationId,
  });

  const context = {
    db,
    repositoryId: repository.id,
    deliveryId: tx.deliveryKey,
    ignore: (reason: string) => tx.ignore(reason),
  };
  switch (intent.kind) {
    case "create_task":
      return actions.createTask(intent, context);
    case "cancel_run":
      return actions.cancelRun(intent, context);
    case "command":
      return actions.command(intent, context);
    case "pr_closed":
      return actions.pullRequestClosed(intent, context);
    case "pr_review":
      return actions.pullRequestReview(intent, context);
  }
}
