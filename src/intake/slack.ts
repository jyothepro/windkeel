

import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { RiskLevel } from "../factory/rails.js";
import { getSystemActor, organizationHoldsGrant } from "../factory/tenancy.js";
import { resolveConnection, resolveRoute } from "../integrations/connections.js";
import { createSlackClient, SlackApiError, type Fetch } from "../integrations/slack.js";
import type { ProviderTokenSource } from "../integrations/token-source.js";
import {
  VercelConnectTokenSource,
  verifyConnectForward,
  type ConnectForwardVerifier,
} from "../integrations/vercel-connect.js";
import { createTaskFromIntake } from "./create-task.js";
import {
  moveDeliveryFeedback,
  selectGrantedRepositoryByName,
  setDeliveryFeedback,
} from "./stores/intake-store.js";
import { defaultLog, describeError, type IntakeLog } from "../factory/log.js";
import {
  ignore,
  IntakeRejection,
  type IntakeIntent,
  type IntakeReply,
  type IntakeResponse,
  type IntakeSource,
  type RawRequest,
} from "./pipeline.js";
import {
  type Queryable,
  SLACK_SOURCE,
  SlackPoster,
  type SlackSourceContext,
  type Sleep,
  ephemeral,
  realSleep,
  releasesClaim,
  slackErrorFields,
} from "./slack-common.js";

export {
  SLACK_SOURCE,
  runLink,
  escapeSlack,
  startMessage,
  SLACK_RETRIES,
  SLACK_RETRY_BACKOFF_MS,
  SLACK_RETRY_BUDGET_MS,
  releasesClaim,
  SlackPoster,
} from "./slack-common.js";
export type { SlackSourceContext, Sleep } from "./slack-common.js";
export {
  slackOutcomeMessage,
  SLACK_THREAD_WAIT_MS,
  SLACK_ANNOUNCE_STALE_MS,
  createSlackNotifier,
  registerSlackNotifier,
} from "./slack-notifier.js";
export type { SlackNotifierOptions } from "./slack-notifier.js";

export type SlackPayload =
  | {
      kind: "command";
      teamId: string;
      channelId: string;
      userId: string;
      command: string;
      text: string;
      triggerId: string;
    }
  | { kind: "url_verification"; challenge: string }
  | {
      kind: "event";
      eventId: string;
      teamId: string;
      eventType: string;
      channel: string | null;
      ts: string | null;
      threadTs: string | null;
      text: string;
      user: string | null;
      botId: string | null;
    }

  | { kind: "other"; type: string; key: string };

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseSlackRequest(req: RawRequest): SlackPayload {
  const raw = typeof req.rawBody === "string" ? req.rawBody : req.rawBody.toString("utf8");
  const contentType = (req.headers["content-type"] ?? "").toLowerCase();
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(raw);
    const teamId = str(form.get("team_id"));
    const channelId = str(form.get("channel_id"));
    const triggerId = str(form.get("trigger_id"));
    if (!teamId || !channelId || !triggerId) {
      throw new IntakeRejection("slash command is missing team_id, channel_id or trigger_id");
    }
    return {
      kind: "command",
      teamId,
      channelId,
      triggerId,
      userId: form.get("user_id") ?? "",
      command: form.get("command") ?? "",
      text: form.get("text") ?? "",
    };
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    throw new IntakeRejection("body is neither a slash command nor a JSON event");
  }
  const type = str(body["type"]);
  if (type === "url_verification") {
    const challenge = str(body["challenge"]);
    if (!challenge) throw new IntakeRejection("url_verification without a challenge");
    return { kind: "url_verification", challenge };
  }
  if (type === "event_callback") {
    const event = (body["event"] ?? {}) as Record<string, unknown>;
    const eventId = str(body["event_id"]);
    const teamId = str(body["team_id"]);
    if (!eventId || !teamId) throw new IntakeRejection("event_callback is missing event_id or team_id");
    return {
      kind: "event",
      eventId,
      teamId,
      eventType: str(event["type"]) ?? "unknown",
      channel: str(event["channel"]),
      ts: str(event["ts"]),
      threadTs: str(event["thread_ts"]),
      text: typeof event["text"] === "string" ? event["text"] : "",
      user: str(event["user"]),
      botId: str(event["bot_id"]),
    };
  }
  if (!type) throw new IntakeRejection("event has no type");
  const key = str(body["event_id"]) ?? `${type}:${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
  return { kind: "other", type, key };
}

function slackDeliveryKey(payload: SlackPayload): string {
  switch (payload.kind) {
    case "command":
      return payload.triggerId;
    case "event":
      return payload.eventId;
    case "url_verification":
      return "url_verification";
    case "other":
      return payload.key;
  }
}

export interface SlackCommand {
  help: boolean;

  repository: { owner: string; name: string; rest: string } | null;

  title: string;
  description: string;
  riskLevel: RiskLevel;
}

const REPO_TOKEN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const RISK_TOKEN = /(^|\s)risk:(low|medium|high)(?=\s|$)/i;
const TITLE_MAX = 200;

export function parseSlackCommand(text: string): SlackCommand {
  let rest = text.replace(/^(\s*<@[A-Z0-9]+(\|[^>]*)?>)+/i, "").trim();
  let riskLevel: RiskLevel = "low";
  const risk = RISK_TOKEN.exec(rest);
  if (risk) {
    riskLevel = risk[2]!.toLowerCase() as RiskLevel;
    rest = (rest.slice(0, risk.index) + risk[1] + rest.slice(risk.index + risk[0].length)).trim();
  }
  if (rest === "" || rest.toLowerCase() === "help") {
    return { help: true, repository: null, title: "", description: "", riskLevel };
  }
  const cuts = [rest.indexOf("\n"), rest.indexOf(" -- ")].filter((i) => i >= 0);
  const cut = cuts.length > 0 ? Math.min(...cuts) : -1;
  const head = (cut >= 0 ? rest.slice(0, cut) : rest).trim();
  const description = cut >= 0 ? rest.slice(cut).replace(/^(\n| -- )/, "").trim() : "";
  const first = head.split(/\s+/)[0] ?? "";
  const repo = REPO_TOKEN.exec(first);
  const repository = repo
    ? { owner: repo[1]!, name: repo[2]!, rest: head.slice(first.length).trim().slice(0, TITLE_MAX) }
    : null;
  return { help: false, repository, title: head.slice(0, TITLE_MAX), description, riskLevel };
}

const SLACK_USAGE =
  "Usage: `/windkeel [owner/repo] <title>` — add a description after a new line or ` -- `, and " +
  "`risk:medium` or `risk:high` to raise the risk level. In a mapped channel, `@Windkeel <same thing>` works too.";

export const SLACK_IGNORE_TEXT: Readonly<Record<string, string>> = {
  help: SLACK_USAGE,
  empty_title: `A task needs a title. ${SLACK_USAGE}`,
  unknown_tenant: "This Slack workspace is not connected to Windkeel. A Windkeel admin can connect it with `windkeel integration connect slack <installation-id>`.",
  no_route:
    "This channel is not mapped to a repository, so Windkeel will not start work from it. A Windkeel admin can map it with " +
    "`windkeel integration route add <integration-id> --repo <repository-id> --scope slack_channel --value <channel-id>`.",
  route_disabled: "Windkeel is switched off for this channel.",
  repository_not_granted:
    "This channel's repository is no longer granted to the Windkeel organization it is connected to, so Windkeel will not start work on it.",
};

export interface SlackIntakeOptions {
  verify?: ConnectForwardVerifier;

  startRun(engineeringRunId: string): Promise<{ enqueued: boolean }>;

  startFeedback?(deliveryKey: string): Promise<unknown>;

  feedbackEnabled?: () => boolean;
  log?: IntakeLog;
}

const SLACK_FEEDBACK_REASONS: ReadonlySet<string> = new Set(["help", "no_route", "route_disabled"]);

export function createSlackIntakeSource(options: SlackIntakeOptions): IntakeSource<SlackPayload> {
  const verifyForward = options.verify ?? verifyConnectForward;
  const log = options.log ?? defaultLog;
  const startFeedback = options.startFeedback;

  function ignoredMention(
    reason: string,
    meta: { event: string; organizationId?: string },
    target: Omit<SlackMentionFeedback, "state" | "reason">,
  ): IntakeIntent {
    return {
      kind: "act",
      intent: "ignore",
      ...meta,
      async act(tx) {
        await tx.ignore(reason);
        await recordMentionFeedback(tx.db, tx.deliveryKey, { state: "pending", reason, ...target });
        const deliveryKey = tx.deliveryKey;
        return async () => {
          try {
            await startFeedback!(deliveryKey);
          } catch (error) {
            log("slack mention feedback not started", { deliveryKey, reason, ...describeError(error) });
          }
        };
      },
    };
  }

  return {
    name: SLACK_SOURCE,

    async verify(req) {
      return (await verifyForward({ headers: req.headers }))
        ? { ok: true }
        : { ok: false, error: "connect forward verification failed" };
    },

    parse: parseSlackRequest,

    deliveryKey: (_req, payload) => slackDeliveryKey(payload),

    async interpret(payload, ctx): Promise<IntakeIntent> {
      if (payload.kind === "url_verification") {
        return { kind: "answer", reason: "url_verification", reply: { status: 200, body: { challenge: payload.challenge } } };
      }
      if (payload.kind === "other") return ignore("unhandled_callback", { event: payload.type });

      const event = payload.kind === "command" ? "slash_command" : payload.eventType;
      let channelId: string;
      let text: string;
      let threadTs: string | null = null;
      let user: string | null;
      if (payload.kind === "event") {
        if (payload.eventType !== "app_mention") return ignore("unhandled_event", { event });
        if (payload.botId) return ignore("bot_message", { event });
        if (!payload.channel || !payload.ts) return ignore("malformed_event", { event });
        channelId = payload.channel;
        text = payload.text;
        threadTs = payload.threadTs ?? payload.ts;
        user = payload.user;
      } else {
        channelId = payload.channelId;
        text = payload.text;
        user = payload.userId || null;
      }

      const feedback =
        payload.kind === "event" && user && startFeedback && (options.feedbackEnabled?.() ?? true)
          ? { teamId: payload.teamId, channelId, user, threadTs: payload.threadTs }
          : null;
      const ignored = (reason: string, meta: { event: string; organizationId?: string }): IntakeIntent =>
        feedback && SLACK_FEEDBACK_REASONS.has(reason) ? ignoredMention(reason, meta, feedback) : ignore(reason, meta);

      const command = parseSlackCommand(text);
      if (command.help) {
        if (!feedback) return ignore("help", { event });

        const connected = await resolveConnection(ctx.db, "slack", payload.teamId);
        return connected
          ? ignored("help", { event, organizationId: connected.organizationId })
          : ignore("help", { event });
      }

      const connection = await resolveConnection(ctx.db, "slack", payload.teamId);

      if (!connection) return ignore("unknown_tenant", { event });
      const organizationId = connection.organizationId;
      const meta = { event, organizationId };

      const route = await resolveRoute(ctx.db, connection.id, { scopeKind: "slack_channel", scopeValue: channelId });
      if (!route || route.scopeKind !== "slack_channel" || route.scopeValue !== channelId) {
        return ignored("no_route", meta);
      }
      if (!route.enabled) return ignored("route_disabled", meta);

      let repositoryId = route.repositoryId;
      let title = command.title;
      if (command.repository) {
        const granted = await grantedRepositoryByName(ctx.db, organizationId, command.repository);
        if (granted) {
          repositoryId = granted;
          title = command.repository.rest;
        }
      }
      if (title === "") return ignore("empty_title", meta);

      const deliveryKey = ctx.deliveryKey;
      const sourceContext: SlackSourceContext = {
        teamId: payload.teamId,
        channelId,
        threadTs,
        requestedBySlackUser: user,
      };

      return {
        kind: "act",
        intent: "create_task",
        ...meta,
        async act(tx) {

          if (!(await organizationHoldsGrant(tx.db, organizationId, repositoryId))) {
            await tx.ignore("repository_not_granted");
            return;
          }
          const actor = await getSystemActor(tx.db, organizationId, SLACK_SOURCE);
          const created = await createTaskFromIntake(
            tx.db,
            {
              organizationId,
              repositoryId,
              sourceType: SLACK_SOURCE,
              sourceReference: `slack:${payload.teamId}:${deliveryKey}`,
              sourceContext: { ...sourceContext },
              title,
              description: command.description || title,
              riskLevel: command.riskLevel,
              createdByPrincipalId: actor.id,
            },
            { startRun: options.startRun },
          );
          await tx.record({
            intent: `create_task:${created.created ? "started" : "existing"}`,
            engineeringTaskId: created.taskId,
          });

          return created.afterCommit;
        },
      };
    },

    respond(response: IntakeResponse, payload: SlackPayload): IntakeReply | undefined {

      if (payload.kind !== "command" || response.status !== 200) return undefined;
      if (response.body.duplicate) return ephemeral("Already on it.");
      if (response.body.intent === "ignore") {
        return ephemeral(SLACK_IGNORE_TEXT[response.body.reason ?? ""] ?? "Windkeel did not start a task for that.");
      }
      return ephemeral("Starting…");
    },
  };
}

async function grantedRepositoryByName(
  db: Queryable,
  organizationId: string,
  repo: { owner: string; name: string },
): Promise<string | null> {
  const { rows } = await selectGrantedRepositoryByName(db, organizationId, repo.owner, repo.name);
  return rows[0]?.id ?? null;
}

export interface SlackMentionFeedback {
  state: "pending" | "posting" | "posted" | "failed" | "skipped";
  reason: string;
  teamId: string;
  channelId: string;
  user: string;

  threadTs: string | null;
  claimedAt?: string;

  failed?: string;
}

async function recordMentionFeedback(db: Queryable, deliveryKey: string, feedback: SlackMentionFeedback): Promise<void> {
  await setDeliveryFeedback(db, SLACK_SOURCE, deliveryKey, JSON.stringify(feedback));
}

async function moveFeedback(
  db: Queryable,
  deliveryKey: string,
  from: SlackMentionFeedback["state"],
  fields: Partial<SlackMentionFeedback>,
): Promise<SlackMentionFeedback | null> {
  const { rows } = await moveDeliveryFeedback<SlackMentionFeedback>(db, SLACK_SOURCE, deliveryKey, JSON.stringify(fields), from);
  return rows[0]?.feedback ?? null;
}

export interface MentionFeedbackOptions {

  pool: Queryable;
  tokenSource?: ProviderTokenSource;
  fetch?: Fetch;
  log?: IntakeLog;
  sleep?: Sleep;
  now?: () => number;
  signal?: AbortSignal;
}

export type MentionFeedbackStatus =

  | "posted"

  | "not_pending"

  | "not_connected"

  | "released"

  | "kept";

export async function postIgnoredMentionFeedback(
  options: MentionFeedbackOptions,
  deliveryKey: string,
): Promise<{ status: MentionFeedbackStatus }> {
  const db = options.pool;
  const log = options.log ?? defaultLog;
  const claimed = await moveFeedback(db, deliveryKey, "pending", {
    state: "posting",
    claimedAt: new Date((options.now ?? Date.now)()).toISOString(),
  });
  if (!claimed) return { status: "not_pending" };
  const fields = { deliveryKey, reason: claimed.reason };

  const text = SLACK_IGNORE_TEXT[claimed.reason];
  const connection = text ? await resolveConnection(db, "slack", claimed.teamId) : null;
  if (!text || !connection) {
    await moveFeedback(db, deliveryKey, "posting", { state: "skipped", failed: text ? "not_connected" : "no_text" });
    log("slack mention feedback skipped", { ...fields, why: text ? "not_connected" : "no_text" });
    return { status: "not_connected" };
  }

  const poster = new SlackPoster(
    createSlackClient({
      tokenSource: options.tokenSource ?? new VercelConnectTokenSource(),
      installationId: connection.installationId,
      fetch: options.fetch,
    }),
    options.sleep ?? realSleep,
    options.now ?? Date.now,
    log,
    options.signal,
  );
  try {
    await poster.ephemeral({ channel: claimed.channelId, user: claimed.user, text, threadTs: claimed.threadTs });
  } catch (error) {
    const released = releasesClaim(error);
    log("slack mention feedback failed", { ...fields, claim: released ? "released" : "kept", ...slackErrorFields(error) });
    const code = error instanceof SlackApiError ? error.code : (describeError(error).errorCode ?? "error");
    await moveFeedback(db, deliveryKey, "posting", released ? { state: "pending" } : { state: "failed", failed: code });
    return { status: released ? "released" : "kept" };
  }
  try {
    await moveFeedback(db, deliveryKey, "posting", { state: "posted" });
  } catch (error) {

    log("slack mention feedback posted but not recorded", { ...fields, ...describeError(error) });
  }
  return { status: "posted" };
}

let feedbackPool: Pool | undefined;

export async function postIgnoredMentionFeedbackFromEnvironment(
  deliveryKey: string,
): Promise<{ status: MentionFeedbackStatus | "not_configured" }> {
  if (!process.env["WINDKEEL_CONNECT_SLACK"]?.trim()) {
    defaultLog("slack mention feedback skipped", { deliveryKey, why: "WINDKEEL_CONNECT_SLACK is not set" });
    return { status: "not_configured" };
  }
  if (!feedbackPool) {
    const connectionString = process.env["DATABASE_POOL_URL"]?.trim() || process.env["DATABASE_URL"]?.trim();
    if (!connectionString) throw new Error("postIgnoredMentionFeedback: DATABASE_URL is not set");
    const { Pool: PgPool } = await import("pg");
    feedbackPool = new PgPool({ connectionString, max: 1, idleTimeoutMillis: 5_000 });
    const { attachDatabasePool } = await import("@vercel/functions");
    attachDatabasePool(feedbackPool);
  }
  return postIgnoredMentionFeedback({ pool: feedbackPool }, deliveryKey);
}
