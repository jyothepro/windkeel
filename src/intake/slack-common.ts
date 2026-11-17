

import type { Pool, PoolClient } from "pg";
import { IntegrationUnavailable } from "../integrations/errors.js";
import {
  SlackApiError,
  type PostEphemeralInput,
  type PostMessageInput,
  type SlackClient,
} from "../integrations/slack.js";
import { describeError, type IntakeLog } from "../factory/log.js";
import { isTransientDatabaseError, type IntakeReply } from "./pipeline.js";

export type Queryable = Pool | PoolClient;

export const SLACK_SOURCE = "slack";

export interface SlackSourceContext {
  teamId: string;
  channelId: string;

  threadTs: string | null;
  requestedBySlackUser: string | null;

  announce?: {
    runId: string;
    claimedAt: string;

    ts?: string;

    failed?: string;
  };

  notified?: string[];
}

export function envConsoleUrl(): string | undefined {
  return process.env["WINDKEEL_CONSOLE_URL"]?.trim() || undefined;
}

export function runLink(consoleUrl: string | undefined, runId: string): string {
  return consoleUrl ? `<${consoleUrl.replace(/\/+$/, "")}/runs/${runId}|run ${runId.slice(0, 8)}>` : `run \`${runId}\``;
}

export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const ephemeral = (text: string): IntakeReply => ({ status: 200, body: { response_type: "ephemeral", text } });

export function startMessage(title: string, runId: string, consoleUrl: string | undefined): string {
  return `Task *${escapeSlack(title)}* started · ${runLink(consoleUrl, runId)}`;
}

export const SLACK_RETRIES = 2;

export const SLACK_RETRY_BACKOFF_MS = [500, 2_000] as const;

export const SLACK_RETRY_BUDGET_MS = 8_000;

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

export function releasesClaim(error: unknown): boolean {
  if (error instanceof SlackApiError) return error.transient && !error.maybeDelivered;
  return error instanceof IntegrationUnavailable || isTransientDatabaseError(error);
}

export function slackErrorFields(error: unknown): Record<string, unknown> {
  return {
    ...describeError(error),
    ...(error instanceof SlackApiError
      ? { slackError: error.code, transient: error.transient, maybeDelivered: error.maybeDelivered }
      : {}),
  };
}

export class SlackPoster {
  private readonly startedAt: number;
  constructor(
    private readonly client: SlackClient,
    private readonly sleep: Sleep,
    private readonly now: () => number,
    private readonly log: IntakeLog,
    private readonly signal: AbortSignal | undefined,
  ) {
    this.startedAt = now();
  }

  private async retrying<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await work();
      } catch (error) {
        if (!(error instanceof SlackApiError) || !releasesClaim(error) || attempt >= SLACK_RETRIES) throw error;
        if (this.signal?.aborted) throw error;
        const wait = Math.max(error.retryAfterMs ?? 0, SLACK_RETRY_BACKOFF_MS[attempt] ?? 0);
        if (this.now() - this.startedAt + wait > SLACK_RETRY_BUDGET_MS) throw error;
        await this.sleep(wait, this.signal);
      }
    }
  }

  async post(input: PostMessageInput): Promise<{ ts: string }> {
    try {
      return await this.retrying(() => this.client.postMessage(input, this.signal));
    } catch (error) {
      if (!(error instanceof SlackApiError) || error.code !== "not_in_channel") throw error;
      try {
        await this.retrying(() => this.client.joinConversation(input.channel, this.signal));
      } catch (joinError) {
        this.log("slack channel join failed: if the channel is private, invite @Windkeel to it", {
          channel: input.channel,
          ...slackErrorFields(joinError),
        });
        throw error;
      }
      return this.retrying(() => this.client.postMessage(input, this.signal));
    }
  }

  async ephemeral(input: PostEphemeralInput): Promise<void> {
    await this.retrying(() => this.client.postEphemeral(input, this.signal));
  }
}
