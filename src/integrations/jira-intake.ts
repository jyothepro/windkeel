

import type { Pool } from "pg";
import type { Criterion } from "@windkeel/verification/evidence/format.js";
import { extractCriteria } from "@windkeel/verification/stages/intent.js";
import { createTaskFromIntake } from "../intake/create-task.js";
import { defaultLog, describeError, redactSecrets, type IntakeLog } from "../factory/log.js";
import { registerSourceNotifier, type RunOutcome, type SourceNotifier } from "../intake/notifiers.js";
import { ignore, IntakeRejection, type AfterCommit, type IntakeSource, type RawRequest } from "../intake/pipeline.js";
import { retriggerExistingTask } from "../intake/relabel.js";
import { getRepository, pullRequestUrl } from "../factory/repository-entity.js";
import { riskLabelOf } from "../factory/issue-intake.js";
import type { RiskLevel } from "../factory/rails.js";
import type { EngineeringRun } from "../factory/repositories.js";
import type { RunState } from "../factory/run-state-machine.js";
import { getSystemActor } from "../factory/tenancy.js";
import { isVerified, verdictLine, VERIFYING_TEXT, type RunVerdict } from "../intake/verdict.js";
import {
  adfDoc,
  adfLink,
  adfParagraph,
  adfStrong,
  adfText,
  adfToText,
  truncateDescription,
  type AdfInline,
} from "./adf.js";
import { resolveConnection, resolveRoute } from "./connections.js";
import { selectTaskRiskBySourceReference } from "../intake/stores/intake-store.js";
import { selectRepositoryGrantRow } from "./stores/connections-store.js";
import { selectJiraSiteUrl } from "./stores/jira-store.js";
import {
  JIRA_INTERACTIVE_TIMEOUT_MS,
  JIRA_WEBHOOK_SECRET_ENV,
  jiraCloudIdFromSelf,
  jiraSiteOrigin,
  resolveJiraCloudId,
  verifyJiraWebhookJwt,
  withJiraClient,
  type FetchLike,
  type JiraTarget,
  type JiraWebhookPayload,
} from "./jira.js";
import type { ProviderTokenSource } from "./token-source.js";

export const JIRA_SOURCE_TYPE = "jira";

const JIRA_START_COMMENT_TIMEOUT_MS = 5_000;

export interface JiraIntakeDeps {

  startRun(engineeringRunId: string): Promise<{ enqueued: boolean }>;

  tokens?: ProviderTokenSource | undefined;
  fetch?: FetchLike;

  secret?: () => string | undefined;

  consoleUrl?: () => string | undefined;
  now?: () => number;
  log?: IntakeLog;
  startCommentTimeoutMs?: number;
}

function labelsOf(payload: JiraWebhookPayload): string[] {
  const labels = payload.issue?.fields?.labels;
  return Array.isArray(labels) ? labels.filter((l): l is string => typeof l === "string") : [];
}

function hasLabel(labels: readonly string[], label: string): boolean {
  const want = label.toLowerCase();
  return labels.some((l) => l.toLowerCase() === want);
}

export function labelArrived(payload: JiraWebhookPayload, label: string): boolean {
  if (!hasLabel(labelsOf(payload), label)) return false;
  if (payload.webhookEvent === "jira:issue_created") return true;
  const items = Array.isArray(payload.changelog?.items) ? payload.changelog.items : [];
  return items.some((item) => {
    if (item?.field !== "labels" && item?.fieldId !== "labels") return false;
    const split = (s: string | null | undefined): string[] => (typeof s === "string" ? s.split(/\s+/).filter(Boolean) : []);
    return hasLabel(split(item.toString), label) && !hasLabel(split(item.fromString), label);
  });
}

export function createJiraIntakeSource(deps: JiraIntakeDeps): IntakeSource<JiraWebhookPayload> {
  const secretOf = deps.secret ?? (() => process.env[JIRA_WEBHOOK_SECRET_ENV]?.trim() || undefined);
  const log = deps.log ?? defaultLog;
  const startCommentTimeoutMs = deps.startCommentTimeoutMs ?? JIRA_START_COMMENT_TIMEOUT_MS;

  return {
    name: "jira",

    async verify(req: RawRequest) {
      const secret = secretOf();

      if (!secret) throw new Error(`${JIRA_WEBHOOK_SECRET_ENV} is not set`);
      const nowSec = Math.floor((deps.now?.() ?? Date.now()) / 1000);
      const verdict = verifyJiraWebhookJwt(req.headers["authorization"], secret, nowSec);
      return verdict.ok ? { ok: true } : { ok: false, status: 401, error: "invalid Jira webhook token" };
    },

    parse(req: RawRequest) {
      const text = typeof req.rawBody === "string" ? req.rawBody : req.rawBody.toString("utf8");
      const value = JSON.parse(text) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new IntakeRejection("body is not a JSON object");
      }
      return value;
    },

    deliveryKey(req: RawRequest, payload: JiraWebhookPayload) {
      const id = req.headers["x-atlassian-webhook-identifier"]?.trim();
      if (!id) throw new IntakeRejection("missing X-Atlassian-Webhook-Identifier header");

      const origin = jiraSiteOrigin(payload.issue?.self);
      if (origin) return `${new URL(origin).host}/${id}`;
      const cloudId = jiraCloudIdFromSelf(payload.issue?.self);
      return cloudId ? `${cloudId}/${id}` : id;
    },

    async interpret(payload, { db }) {
      const event = typeof payload.webhookEvent === "string" ? payload.webhookEvent : null;
      const action = typeof payload.issue_event_type_name === "string" ? payload.issue_event_type_name : null;
      const meta = { event, action };
      if (event !== "jira:issue_created" && event !== "jira:issue_updated") {
        return ignore("unsupported_event", meta);
      }
      const issue = payload.issue;
      const issueKey = typeof issue?.key === "string" ? issue.key : null;
      const issueId = typeof issue?.id === "string" || typeof issue?.id === "number" ? String(issue.id) : null;
      if (!issueKey || !issueId) return ignore("no_issue", meta);

      const cloudId = await resolveJiraCloudId(db, payload);
      const connection = cloudId ? await resolveConnection(db, "jira", cloudId) : null;
      if (!cloudId || !connection) return ignore("unknown_tenant", meta);
      const organizationId = connection.organizationId;
      const withOrg = { ...meta, organizationId };

      const projectKey = typeof issue?.fields?.project?.key === "string" ? issue.fields.project.key : null;
      const route = await resolveRoute(db, connection.id, { scopeKind: "jira_project", scopeValue: projectKey });
      if (!route) return ignore("no_route", withOrg);
      if (!route.enabled) return ignore("route_disabled", withOrg);
      if (!hasLabel(labelsOf(payload), route.triggerLabel)) return ignore("no_trigger_label", withOrg);
      if (!labelArrived(payload, route.triggerLabel)) return ignore("label_not_added", withOrg);

      const labelRisk: RiskLevel | undefined = riskLabelOf(labelsOf(payload));
      const summary = typeof issue?.fields?.summary === "string" && issue.fields.summary.trim() ? issue.fields.summary.trim() : issueKey;
      const title = `${issueKey}: ${summary}`.slice(0, 500);
      const body = truncateDescription(adfToText(issue?.fields?.description));
      const { rows: siteRows } = await selectJiraSiteUrl(db, connection.id);
      const siteUrl = jiraSiteOrigin(issue?.self) ?? siteRows[0]?.site_url ?? null;
      const issueUrl = siteUrl ? `${siteUrl}/browse/${issueKey}` : null;
      const description = [body, issueUrl ? `Jira issue: ${issueUrl}` : `Jira issue: ${issueKey}`]
        .filter((s) => s.length > 0)
        .join("\n\n");
      const reference = `jira:${cloudId}/${issueId}`;
      const criteriaSource: Criterion["source"] = { kind: "explicit", ref: issueUrl ?? reference };
      const sourceContext = { cloudId, issueKey, issueId, siteUrl };
      const target: JiraTarget | null = deps.tokens
        ? {
            tokens: deps.tokens,
            installationId: connection.installationId,
            cloudId,
            fetch: deps.fetch,
            timeoutMs: JIRA_INTERACTIVE_TIMEOUT_MS,
          }
        : null;

      const startAndAnnounce = (runId: string): AfterCommit => async () => {
        await deps.startRun(runId);
        if (!target) return;
        try {
          await postJiraComment(
            target,
            issueKey,
            jiraStartedComment({ runId, runUrl: runLink(deps.consoleUrl, runId) }),
            startedMarker(runId),
            AbortSignal.timeout(startCommentTimeoutMs),
          );
        } catch (error) {
          log("jira acknowledgement comment failed", { issueKey, engineeringRunId: runId, ...describeError(error) });
        }
      };

      return {
        kind: "act",
        intent: "create_task",
        ...withOrg,
        act: async (tx) => {

          const { rows: grant } = await selectRepositoryGrantRow(tx.db, organizationId, route.repositoryId);
          if (grant.length === 0) {
            await tx.ignore("repository_not_granted");
            return;
          }

          const { rows } = await selectTaskRiskBySourceReference(tx.db, organizationId, JIRA_SOURCE_TYPE, reference);
          const existing = rows[0];
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

          const actor = await getSystemActor(tx.db, organizationId, "jira");
          const created = await createTaskFromIntake(
            tx.db,
            {
              organizationId,
              repositoryId: route.repositoryId,
              sourceType: JIRA_SOURCE_TYPE,
              sourceReference: reference,
              sourceContext,
              title,
              description,
              riskLevel: labelRisk ?? "low",
              createdByPrincipalId: actor.id,
              criteriaSource,
            },
            { startRun: deps.startRun },
          );
          await tx.record({ engineeringTaskId: created.taskId });
          if (!created.created) {

            await tx.ignore("already_tasked");
            return async () => {
              await created.afterCommit();
            };
          }
          return startAndAnnounce(created.runId);
        },
      };
    },
  };
}

function startedMarker(runId: string): string {
  return `windkeel-run ${runId} started`;
}

function transitionMarker(transitionId: string): string {
  return `windkeel-transition ${transitionId}`;
}

function runLink(consoleUrl: (() => string | undefined) | undefined, runId: string): string | null {
  const base = (consoleUrl ? consoleUrl() : process.env["WINDKEEL_CONSOLE_URL"])?.trim().replace(/\/+$/, "");
  return base ? `${base}/runs/${runId}` : null;
}

function runRef(runId: string, runUrl: string | null): AdfInline {
  return runUrl ? adfLink(`run ${runId}`, runUrl) : adfText(`run ${runId}`);
}

function jiraStartedComment(input: { runId: string; runUrl: string | null }) {
  return adfDoc(
    adfParagraph(adfText("Windkeel picked this up and started "), runRef(input.runId, input.runUrl), adfText(".")),
    adfParagraph(adfText(startedMarker(input.runId))),
  );
}

const REASON_SUMMARY_CHARS = 160;

export function reasonSummary(reason: string | null): string | null {
  if (!reason) return null;
  const firstLine = reason.split(/\r?\n/, 1)[0] ?? "";
  const cleaned = redactSecrets(firstLine)
    .replace(/\bhttps?:\/\/\S+/gi, "[link]")
    .replace(/(?:\/[\w.-]+){2,}/g, "[path]")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > REASON_SUMMARY_CHARS ? `${cleaned.slice(0, REASON_SUMMARY_CHARS - 1).trimEnd()}…` : cleaned;
}

export interface OutcomeCommentInput {
  runId: string;
  transitionId: string;
  state: RunState;
  reason: string | null;
  runUrl: string | null;
  prUrl: string | null;

  verdict?: RunVerdict | null;
}

function verifyingMarker(runId: string): string {
  return `windkeel-run ${runId} verifying`;
}

function jiraVerifyingComment(input: { runId: string; runUrl: string | null }) {
  return adfDoc(
    adfParagraph(adfText(`${VERIFYING_TEXT} `), runRef(input.runId, input.runUrl)),
    adfParagraph(adfText(verifyingMarker(input.runId))),
  );
}

export function jiraOutcomeComment(input: OutcomeCommentInput) {
  const paragraphs = [];
  const summary = reasonSummary(input.reason);

  const verdict = input.verdict !== undefined ? verdictLine(input.verdict) : null;
  switch (input.state) {
    case "COMPLETED":
      paragraphs.push(
        input.prUrl
          ? adfParagraph(adfStrong("Windkeel finished."), adfText(" Verified draft PR: "), adfLink(input.prUrl, input.prUrl))
          : adfParagraph(adfStrong("Windkeel finished."), adfText(" The run completed.")),
      );
      break;
    case "WAITING_FOR_HUMAN":
      if (input.prUrl && isVerified(input.verdict)) {
        paragraphs.push(adfParagraph(adfStrong(`${verdict}.`), adfText(" Draft PR for review: "), adfLink(input.prUrl, input.prUrl)));
      } else {
        paragraphs.push(
          input.prUrl
            ? adfParagraph(
                adfStrong("Windkeel needs a human."),
                adfText(verdict ? ` ${verdict}.` : ""),
                adfText(" Draft PR for review: "),
                adfLink(input.prUrl, input.prUrl),
              )
            : adfParagraph(adfStrong("Windkeel needs a human."), adfText(verdict ? ` ${verdict}.` : ""), adfText(summary ? ` ${summary}` : "")),
        );
      }
      break;
    case "WAITING_FOR_APPROVAL":
      paragraphs.push(
        adfParagraph(
          adfStrong("Windkeel is waiting for approval."),
          adfText(" This issue had no explicit acceptance criteria, so Windkeel proposed some; approve them to continue."),
        ),
      );
      break;
    case "CANCELLED":
      paragraphs.push(adfParagraph(adfStrong("Windkeel's run was cancelled."), adfText(summary ? ` ${summary}` : "")));
      break;
    default:
      paragraphs.push(
        adfParagraph(
          adfStrong("Windkeel could not finish."),
          adfText(verdict ? ` ${verdict}.` : ""),
          adfText(summary ? ` Reason: ${summary}` : ""),
        ),
      );
  }
  paragraphs.push(adfParagraph(adfText("Details: "), runRef(input.runId, input.runUrl)));
  paragraphs.push(adfParagraph(adfText(transitionMarker(input.transitionId))));
  return adfDoc(...paragraphs);
}

async function postJiraComment(
  target: JiraTarget,
  issueKey: string,
  body: unknown,
  marker: string,
  signal?: AbortSignal,
): Promise<"posted" | "already_posted"> {
  return withJiraClient(
    target,
    async (client) => {
      const recent = await client.recentComments(issueKey);
      if (recent.some((c) => adfToText(c).includes(marker))) return "already_posted" as const;
      await client.addComment(issueKey, body);
      return "posted" as const;
    },
    signal,
  );
}

export interface JiraNotifierDeps {
  pool: Pool;
  tokens: ProviderTokenSource;
  fetch?: FetchLike;
  consoleUrl?: () => string | undefined;
  log?: IntakeLog;
}

export function createJiraNotifier(deps: JiraNotifierDeps): SourceNotifier {
  const log = deps.log ?? defaultLog;
  return {
    sourceType: JIRA_SOURCE_TYPE,
    async notify(task, run: EngineeringRun, outcome: RunOutcome, signal?: AbortSignal) {

      if (outcome.kind === "started") return;
      try {
        const cloudId = task.sourceContext["cloudId"];
        const issueKey = task.sourceContext["issueKey"];
        if (typeof cloudId !== "string" || typeof issueKey !== "string") {
          log("jira notification skipped", { engineeringRunId: run.id, reason: "no_source_context" });
          return;
        }
        const connection = await resolveConnection(deps.pool, "jira", cloudId);
        if (!connection || connection.organizationId !== task.organizationId) {
          log("jira notification skipped", { engineeringRunId: run.id, reason: "not_connected" });
          return;
        }

        let prUrl: string | null = null;
        if (run.prNumber !== null) {
          const repository = await getRepository(deps.pool, task.repositoryId);
          if (repository) prUrl = pullRequestUrl(repository, run.prNumber);
        }
        const target = {
          tokens: deps.tokens,
          installationId: connection.installationId,
          cloudId,
          fetch: deps.fetch,
          timeoutMs: JIRA_INTERACTIVE_TIMEOUT_MS,
        };
        const runUrl = runLink(deps.consoleUrl, run.id);
        const result =
          outcome.kind === "progress"
            ? await postJiraComment(target, issueKey, jiraVerifyingComment({ runId: run.id, runUrl }), verifyingMarker(run.id), signal)
            : await postJiraComment(
                target,
                issueKey,
                jiraOutcomeComment({
                  runId: run.id,
                  transitionId: outcome.transitionId,
                  state: outcome.state,
                  reason: outcome.reason,
                  runUrl,
                  prUrl,
                  ...(outcome.verdict !== undefined ? { verdict: outcome.verdict } : {}),
                }),
                transitionMarker(outcome.transitionId),
                signal,
              );
        if (result === "already_posted") log("jira notification already posted", { engineeringRunId: run.id, state: outcome.state });
      } catch (error) {

        log("jira notification failed", { engineeringRunId: run.id, state: outcome.state, ...describeError(error) });
      }
    },
  };
}

export function registerJiraNotifier(deps: JiraNotifierDeps): void {
  registerSourceNotifier(createJiraNotifier(deps));
}
