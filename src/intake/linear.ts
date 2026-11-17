import type { Criterion } from "@windkeel/verification/evidence/format.js";
import { extractCriteria } from "@windkeel/verification/stages/intent.js";
import type { RiskLevel } from "../factory/rails.js";
import { riskLabelOf } from "../factory/issue-intake.js";
import type { RailsOptions } from "../factory/task-creation.js";
import { getSystemActor, organizationHoldsGrant, taskRepositoryGranted } from "../factory/tenancy.js";
import { resolveConnection, resolveRoute, type IntegrationRoute } from "../integrations/connections.js";
import {
  LINEAR_SOURCE_TYPE,
  LINEAR_START_COMMENT_TIMEOUT_MS,
  postLinearStartComment,
  type LinearClientDeps,
} from "../integrations/linear.js";
import type { ProviderTokenSource } from "../integrations/token-source.js";
import { verifyConnectForward, type ConnectForwardVerifier } from "../integrations/vercel-connect.js";
import { createTaskFromIntake } from "./create-task.js";
import { defaultLog, describeError, type IntakeLog } from "../factory/log.js";
import { ignore, IntakeRejection, type AfterCommit, type IntakeSource, type RawRequest } from "./pipeline.js";
import { retriggerExistingTask } from "./relabel.js";
import { selectTaskRiskBySourceReference } from "./stores/intake-store.js";

export const LINEAR_REPLAY_TOLERANCE_MS = 5 * 60 * 1000;

export interface LinearLabel {
  id?: string;
  name?: string;
}

export interface LinearIssueData {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string | null;
  url?: string;
  teamId?: string;
  team?: { id?: string; key?: string } | null;
  labelIds?: string[];
  labels?: LinearLabel[];
}

export interface LinearWebhookPayload {
  action?: string;
  type?: string;
  data?: LinearIssueData;
  updatedFrom?: { labelIds?: string[] | null } & Record<string, unknown>;
  url?: string;
  organizationId?: string;
  webhookId?: string;
  webhookTimestamp?: number;
}

type Log = IntakeLog;

export interface LinearIntakeDeps {
  startRun(engineeringRunId: string): Promise<{ enqueued: boolean }>;
  tokenSource: ProviderTokenSource;
  verifyForward?: ConnectForwardVerifier;
  fetch?: LinearClientDeps["fetch"];
  consoleUrl?: () => string | undefined;
  now?: () => number;
  log?: Log;
  rails?: RailsOptions;
  startCommentTimeoutMs?: number;
}

function linearSourceReference(organizationId: string, issueId: string): string {
  return `linear:${organizationId}:${issueId}`;
}

export function createLinearIntakeSource(deps: LinearIntakeDeps): IntakeSource<LinearWebhookPayload> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? defaultLog;
  const consoleUrl = deps.consoleUrl ?? (() => process.env["WINDKEEL_CONSOLE_URL"]?.trim() || undefined);
  const verifyForward = deps.verifyForward ?? verifyConnectForward;
  const client: LinearClientDeps = { tokenSource: deps.tokenSource, ...(deps.fetch ? { fetch: deps.fetch } : {}) };
  const startCommentTimeoutMs = deps.startCommentTimeoutMs ?? LINEAR_START_COMMENT_TIMEOUT_MS;

  return {
    name: "linear",

    async verify(req: RawRequest) {
      return (await verifyForward({ headers: req.headers }))
        ? { ok: true }
        : { ok: false, status: 401, error: "connect forward verification failed" };
    },

    parse(req: RawRequest): LinearWebhookPayload {
      const payload = JSON.parse(String(req.rawBody)) as unknown;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new IntakeRejection("body is not a Linear webhook");
      }
      const typed = payload as LinearWebhookPayload;
      const ts = typed.webhookTimestamp;
      if (typeof ts !== "number" || !Number.isFinite(ts)) {
        throw new IntakeRejection("webhookTimestamp is missing");
      }
      if (Math.abs(now() - ts) > LINEAR_REPLAY_TOLERANCE_MS) {
        throw new IntakeRejection("webhookTimestamp is outside the replay window", 401);
      }
      return typed;
    },

    deliveryKey(req: RawRequest, payload: LinearWebhookPayload): string {
      const header = req.headers["linear-delivery"]?.trim();
      if (header) return header;
      if (payload.webhookId && payload.data?.id) {
        return `${payload.webhookId}:${payload.data.id}:${payload.webhookTimestamp}`;
      }
      throw new IntakeRejection("missing Linear-Delivery");
    },

    async interpret(payload, { db }) {
      const meta = { event: typeof payload.type === "string" ? payload.type : null, action: payload.action ?? null };
      const tenant = payload.organizationId;
      if (typeof tenant !== "string" || tenant === "") return ignore("unknown_tenant", meta);
      const connection = await resolveConnection(db, "linear", tenant);
      if (!connection) return ignore("unknown_tenant", meta);
      const scoped = { ...meta, organizationId: connection.organizationId };

      if (payload.type !== "Issue") return ignore("not_an_issue", scoped);
      if (payload.action === "remove") return ignore("removed", scoped);
      if (payload.action !== "create" && payload.action !== "update") return ignore("unsupported_action", scoped);

      const issue = payload.data;
      if (!issue || typeof issue.id !== "string" || issue.id === "") return ignore("malformed_issue", scoped);

      const route = await routeFor(db, connection.id, issue);
      if (!route) return ignore("no_route", scoped);
      if (!route.enabled) return ignore("route_disabled", scoped);

      if (!Array.isArray(issue.labels)) {
        return ignore(Array.isArray(issue.labelIds) && issue.labelIds.length > 0 ? "labels_unavailable" : "label_absent", scoped);
      }
      const trigger = route.triggerLabel.toLowerCase();
      const labels = issue.labels;
      const triggerLabels = labels.filter((l) => typeof l?.name === "string" && l.name.toLowerCase() === trigger);
      if (triggerLabels.length === 0) return ignore("label_absent", scoped);
      if (payload.action === "update") {
        const before = payload.updatedFrom?.labelIds;
        const newlyAdded =
          Array.isArray(before) && triggerLabels.some((l) => typeof l.id === "string" && !before.includes(l.id));
        if (!newlyAdded) return ignore("label_not_newly_added", scoped);
      }

      const organizationId = connection.organizationId;
      const installationId = connection.installationId;
      const issueId = issue.id;
      const labelNames = labels.map((l) => l?.name).filter((n): n is string => typeof n === "string");
      const labelRisk: RiskLevel | undefined = riskLabelOf(labelNames);
      const url = typeof issue.url === "string" ? issue.url : typeof payload.url === "string" ? payload.url : undefined;
      const title = typeof issue.title === "string" && issue.title.trim() !== "" ? issue.title : issue.identifier ?? issueId;
      const description = typeof issue.description === "string" ? issue.description : "";
      const reference = linearSourceReference(tenant, issueId);
      const criteriaSource: Criterion["source"] = { kind: "linked_issue", ref: url ?? reference };
      const teamId = issue.teamId ?? issue.team?.id;
      const sourceContext = {
        organizationId: tenant,
        issueId,
        ...(issue.identifier ? { identifier: issue.identifier } : {}),
        ...(url ? { url } : {}),
        ...(teamId ? { teamId } : {}),
      };

      const startAndAnnounce = (runId: string): AfterCommit => async () => {
        await deps.startRun(runId);
        try {
          await postLinearStartComment(client, {
            installationId,
            issueId,
            runId,
            consoleUrl: consoleUrl(),
            signal: AbortSignal.timeout(startCommentTimeoutMs),
          });
        } catch (error) {
          log("linear start comment failed", { engineeringRunId: runId, ...describeError(error) });
        }
      };

      return {
        kind: "act",
        intent: "create_task",
        ...scoped,
        async act(tx) {
          const actor = await getSystemActor(tx.db, organizationId, "linear");

          const { rows } = await selectTaskRiskBySourceReference(tx.db, organizationId, LINEAR_SOURCE_TYPE, reference);
          const existing = rows[0];
          const granted = existing
            ? await taskRepositoryGranted(tx.db, existing.id)
            : await organizationHoldsGrant(tx.db, organizationId, route.repositoryId);
          if (!granted) {
            if (existing) await tx.record({ engineeringTaskId: existing.id });
            await tx.ignore("repository_not_granted");
            return;
          }
          if (existing) {
            const outcome = await retriggerExistingTask(
              tx.db,
              { id: existing.id, riskLevel: existing.risk_level },
              {
                title,
                description,
                criteria: extractCriteria(description, criteriaSource),
                ...(labelRisk ? { riskLevel: labelRisk } : {}),
                sourceContext,
                ...(deps.rails ? { rails: deps.rails } : {}),
              },
            );
            if (outcome.kind === "already_tasked") {
              await tx.record({ engineeringTaskId: existing.id });
              await tx.ignore("already_tasked");
              return;
            }
            await tx.record({
              intent: outcome.kind === "rerun" ? "create_task:rerun" : "create_task:restarted",
              engineeringTaskId: existing.id,
            });
            return startAndAnnounce(outcome.run.id);
          }

          const created = await createTaskFromIntake(
            tx.db,
            {
              organizationId,
              repositoryId: route.repositoryId,
              sourceType: LINEAR_SOURCE_TYPE,
              sourceReference: reference,
              sourceContext,
              title,
              description,
              riskLevel: labelRisk ?? "low",
              ...(deps.rails ? { rails: deps.rails } : {}),
              createdByPrincipalId: actor.id,
              criteriaSource,
            },
            { startRun: deps.startRun },
          );
          if (!created.created) {
            await tx.record({ engineeringTaskId: created.taskId });
            await tx.ignore("already_tasked");
            return async () => {
              await created.afterCommit();
            };
          }
          await tx.record({ intent: "create_task:started", engineeringTaskId: created.taskId });
          return startAndAnnounce(created.runId);
        },
      };
    },
  };
}

async function routeFor(
  db: Parameters<typeof resolveRoute>[0],
  connectionId: string,
  issue: LinearIssueData,
): Promise<IntegrationRoute | null> {
  const teamId = issue.teamId ?? issue.team?.id ?? null;
  const byId = await resolveRoute(db, connectionId, { scopeKind: "linear_team", scopeValue: teamId });
  if (byId && byId.scopeKind !== "default") return byId;
  const key = issue.team?.key;
  if (key) {
    const byKey = await resolveRoute(db, connectionId, { scopeKind: "linear_team", scopeValue: key });
    if (byKey) return byKey;
  }
  return byId;
}
