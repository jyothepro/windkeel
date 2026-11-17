

import type { EngineeringRun } from "../factory/repositories.js";
import { getRepository, pullRequestUrl } from "../factory/repository-entity.js";
import { resolveConnection } from "../integrations/connections.js";
import { createSlackClient, SlackApiError, type Fetch } from "../integrations/slack.js";
import type { ProviderTokenSource } from "../integrations/token-source.js";
import { isVerified, verdictLine, VERIFYING_TEXT, verifyingClaimKey } from "./verdict.js";
import { VercelConnectTokenSource } from "../integrations/vercel-connect.js";
import {
  claimAnnounce,
  claimNotifiedTransition,
  markAnnounceClaimFailed,
  recordAnnounceTs,
  releaseAnnounceClaim,
  releaseNotifiedTransition,
  selectTaskSourceContext,
} from "./stores/intake-store.js";
import { defaultLog, describeError, redactSecrets, type IntakeLog } from "../factory/log.js";
import type { NotifiedTask, RunOutcome, SourceNotifier } from "./notifiers.js";
import { registerSourceNotifier } from "./notifiers.js";
import { isTransientDatabaseError } from "./pipeline.js";
import {
  type Queryable,
  SLACK_SOURCE,
  SlackPoster,
  type SlackSourceContext,
  type Sleep,
  envConsoleUrl,
  escapeSlack,
  realSleep,
  releasesClaim,
  runLink,
  slackErrorFields,
  startMessage,
} from "./slack-common.js";

export function slackOutcomeMessage(
  task: Pick<NotifiedTask, "title">,
  run: Pick<EngineeringRun, "id" | "prNumber">,
  outcome: Pick<RunOutcome, "kind" | "state" | "reason" | "verdict">,
  facts: { consoleUrl: string | undefined; pullRequestUrl: string | null },
): string | null {
  if (outcome.kind === "started") return null;
  const title = `*${escapeSlack(task.title)}*`;
  const link = runLink(facts.consoleUrl, run.id);

  if (outcome.kind === "progress") return `${title}: ${VERIFYING_TEXT} · ${link}`;
  const reason = outcome.reason ? escapeSlack(redactSecrets(outcome.reason).slice(0, 500)) : null;
  const pullRequest = facts.pullRequestUrl ? `<${facts.pullRequestUrl}|draft PR #${run.prNumber}>` : null;

  const verdict = outcome.verdict !== undefined ? escapeSlack(verdictLine(outcome.verdict)) : null;
  switch (outcome.state) {
    case "WAITING_FOR_APPROVAL":
      return (
        `${title} needs its acceptance criteria approved before work starts. ` +
        `Approve with \`windkeel approve ${run.id}\`${facts.consoleUrl ? ` or in the console: ${link}` : ""}.`
      );
    case "WAITING_FOR_HUMAN":
      if (pullRequest && isVerified(outcome.verdict)) return `${title}: ${verdict} · ${pullRequest} · ${link}`;
      return `${title} needs a human${verdict ? ` — ${verdict}` : ""}${reason ? `: ${reason}` : ""}${pullRequest ? ` · ${pullRequest}` : ""} · ${link}`;
    case "COMPLETED":
      return `${title} is done${pullRequest ? `: ${pullRequest}` : ""} · ${link}`;
    case "CANCELLED":
      return `${title} was cancelled${reason ? `: ${reason}` : ""} · ${link}`;
    case "FAILED":
      return `${title} failed${verdict ? ` — ${verdict}` : ""}${reason ? `: ${reason}` : ""} · ${link}`;
    case "MAX_REPAIR_ATTEMPTS_REACHED":
      return `${title} failed: verification still failing after the maximum repair attempts${verdict ? ` — ${verdict}` : ""}${reason ? ` (${reason})` : ""} · ${link}`;
    default:
      return null;
  }
}

export const SLACK_THREAD_WAIT_MS = 5_000;
const THREAD_POLL_MS = 100;

export const SLACK_ANNOUNCE_STALE_MS = 30_000;

const TS_WRITE_RETRIES = 2;
const TS_WRITE_BACKOFF_MS = 100;

class ThreadUnavailable extends Error {
  override readonly name = "ThreadUnavailable";
}

export interface SlackNotifierOptions {

  pool: Queryable;
  tokenSource?: ProviderTokenSource;
  fetch?: Fetch;

  consoleUrl?: () => string | undefined;
  log?: IntakeLog;

  sleep?: Sleep;
  now?: () => number;
}

async function readContext(db: Queryable, taskId: string): Promise<Partial<SlackSourceContext>> {
  const { rows } = await selectTaskSourceContext<Partial<SlackSourceContext>>(db, taskId);
  return rows[0]?.source_context ?? {};
}

export function createSlackNotifier(options: SlackNotifierOptions): SourceNotifier {
  let tokenSource = options.tokenSource;
  const tokens = (): ProviderTokenSource => (tokenSource ??= new VercelConnectTokenSource());
  const consoleUrl = options.consoleUrl ?? envConsoleUrl;
  const log = options.log ?? defaultLog;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const db = options.pool;

  async function settle(
    error: unknown,
    release: () => Promise<unknown>,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const released = releasesClaim(error);
    log("slack notification failed", { ...fields, claim: released ? "released" : "kept", ...slackErrorFields(error) });
    if (!released) return;
    try {
      await release();
    } catch (releaseError) {

      log("slack claim release failed", { ...fields, ...describeError(releaseError) });
    }
  }

  async function markAnnounceFailed(taskId: string, reason: string, fields: Record<string, unknown>): Promise<void> {
    try {
      await markAnnounceClaimFailed(db, taskId, reason);
    } catch (error) {

      log("slack start claim could not be marked failed", { ...fields, ...describeError(error) });
    }
  }

  async function ensureThread(
    poster: SlackPoster,
    task: NotifiedTask,
    run: EngineeringRun,
    fields: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<string | null> {
    const claimed = await claimAnnounce<SlackSourceContext>(db, task.id, run.id, SLACK_ANNOUNCE_STALE_MS);
    const mine = claimed.rows[0]?.source_context;
    if (!mine) return waitForThread(task.id, fields, signal);

    const startFields = { ...fields, post: "start" };
    let posted: { ts: string };
    try {
      posted = await poster.post({
        channel: mine.channelId,
        threadTs: mine.threadTs,
        text: startMessage(task.title, run.id, consoleUrl()),
      });
    } catch (error) {
      if (releasesClaim(error)) {
        await settle(error, () => releaseAnnounceClaim(db, task.id), startFields);
        throw new ThreadUnavailable("start message not posted");
      }
      await settle(error, async () => {}, startFields);

      await markAnnounceFailed(task.id, error instanceof SlackApiError ? error.code : "error", startFields);
      return mine.threadTs ?? null;
    }

    const threadTs = mine.threadTs ?? posted.ts;
    for (let attempt = 0; ; attempt++) {
      try {
        await recordAnnounceTs(db, task.id, posted.ts);
        return threadTs;
      } catch (error) {
        if (attempt >= TS_WRITE_RETRIES || !isTransientDatabaseError(error)) {
          log("slack start message posted but its ts was not stored; claim kept", {
            ...startFields,
            ...describeError(error),
          });
          await markAnnounceFailed(task.id, "ts_not_stored", startFields);
          return threadTs;
        }
        await sleep(TS_WRITE_BACKOFF_MS * (attempt + 1), signal).catch(() => {});
      }
    }
  }

  async function waitForThread(
    taskId: string,
    fields: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<string | null> {
    const deadline = now() + SLACK_THREAD_WAIT_MS;
    for (;;) {
      if (signal?.aborted) {
        log("slack notification abandoned while waiting for the thread root", fields);
        throw new ThreadUnavailable("aborted while waiting for the thread root");
      }
      const context = await readContext(db, taskId);
      const announce = context.announce;
      if (!announce || announce.ts || announce.failed || now() >= deadline) return context.threadTs ?? null;
      try {
        await realSleep(THREAD_POLL_MS, signal);
      } catch {

      }
    }
  }

  return {
    sourceType: SLACK_SOURCE,
    async notify(task, run, outcome, signal) {
      const fields = {
        engineeringRunId: run.id,
        state: outcome.state,
        kind: outcome.kind,
        transitionId: outcome.transitionId,
      };
      try {
        const context = task.sourceContext as Partial<SlackSourceContext>;
        if (!context.teamId || !context.channelId) {
          log("slack notification skipped", { ...fields, reason: "no_source_context" });
          return;
        }

        let text: string | null = null;
        if (outcome.kind !== "started") {

          let prUrl: string | null = null;
          if (run.prNumber !== null) {
            const repository = await getRepository(db, task.repositoryId);
            if (repository) prUrl = pullRequestUrl(repository, run.prNumber);
          }
          text = slackOutcomeMessage(task, run, outcome, { consoleUrl: consoleUrl(), pullRequestUrl: prUrl });
          if (!text) return;
        }

        const connection = await resolveConnection(db, "slack", context.teamId);
        if (!connection) {
          log("slack notification skipped", { ...fields, reason: "not_connected" });
          return;
        }
        const poster = new SlackPoster(
          createSlackClient({
            tokenSource: tokens(),
            installationId: connection.installationId,
            fetch: options.fetch,
          }),
          sleep,
          now,
          log,
          signal,
        );

        let threadTs: string | null;
        try {
          threadTs = await ensureThread(poster, task, run, fields, signal);
        } catch (error) {
          if (error instanceof ThreadUnavailable) return;
          throw error;
        }
        if (outcome.kind === "started" || text === null) return;

        const claim = outcome.kind === "progress" ? verifyingClaimKey(run.id) : outcome.transitionId;
        if (!(await claimOutcome(db, task.id, claim))) return;
        try {
          await poster.post({ channel: context.channelId, threadTs, text });
        } catch (error) {
          await settle(error, () => releaseOutcome(db, task.id, claim), { ...fields, post: "outcome" });
        }
      } catch (error) {

        log("slack notification failed", { ...fields, ...slackErrorFields(error) });
      }
    },
  };
}

async function claimOutcome(db: Queryable, taskId: string, transitionId: string): Promise<boolean> {
  const { rowCount } = await claimNotifiedTransition(db, taskId, transitionId);
  return (rowCount ?? 0) > 0;
}

async function releaseOutcome(db: Queryable, taskId: string, transitionId: string): Promise<void> {
  await releaseNotifiedTransition(db, taskId, transitionId);
}

export function registerSlackNotifier(options: SlackNotifierOptions): void {
  registerSourceNotifier(createSlackNotifier(options));
}
