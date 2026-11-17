import { ProviderUnauthorized } from "./errors.js";
import { withProviderToken, type ProviderTokenSource } from "./token-source.js";

const SLACK_API_BASE = "https://slack.com/api";

export const SLACK_SCOPES = ["commands", "chat:write", "app_mentions:read", "channels:join"] as const;

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

const UNAUTHORIZED_CODES = new Set(["invalid_auth", "not_authed", "token_expired", "token_revoked"]);
const TRANSIENT_CODES = new Set(["ratelimited", "internal_error", "fatal_error", "service_unavailable", "request_timeout"]);

export class SlackApiError extends Error {
  override readonly name = "SlackApiError";
  constructor(
    readonly method: string,
    readonly code: string,
    readonly transient: boolean,
    readonly extra: { maybeDelivered?: boolean; retryAfterMs?: number } = {},
  ) {
    super(`slack ${method} failed: ${code}`);
  }

  get maybeDelivered(): boolean {
    return this.extra.maybeDelivered === true;
  }

  get retryAfterMs(): number | undefined {
    return this.extra.retryAfterMs;
  }
}

export interface SlackClientOptions {
  tokenSource: ProviderTokenSource;
  installationId: string;
  fetch?: Fetch | undefined;
}

export interface PostMessageInput {
  channel: string;
  text: string;
  threadTs?: string | null;
}

export interface PostEphemeralInput {
  channel: string;
  user: string;
  text: string;
  threadTs?: string | null;
}

export interface SlackClient {
  postMessage(input: PostMessageInput, signal?: AbortSignal): Promise<{ ts: string; channel: string }>;
  postEphemeral(input: PostEphemeralInput, signal?: AbortSignal): Promise<void>;
  joinConversation(channel: string, signal?: AbortSignal): Promise<void>;
}

export function createSlackClient(options: SlackClientOptions): SlackClient {
  return {
    postMessage: (input, signal) => postSlackMessage(options, input, signal),
    postEphemeral: async (input, signal) => {
      await slackCall(
        options,
        "chat.postEphemeral",
        {
          channel: input.channel,
          user: input.user,
          text: input.text,
          ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
        },
        signal,
      );
    },
    joinConversation: async (channel, signal) => {
      await slackCall(options, "conversations.join", { channel }, signal);
    },
  };
}

const PRE_SEND_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function networkCode(error: unknown): string {
  const cause = error && typeof error === "object" ? (error as { cause?: unknown }).cause : undefined;
  for (const candidate of [cause, error]) {
    const code = candidate && typeof candidate === "object" ? (candidate as { code?: unknown }).code : undefined;
    if (typeof code === "string") return code;
  }
  return "";
}

function retryAfter(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

async function slackCall<T extends Record<string, unknown>>(
  options: SlackClientOptions,
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const doFetch: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  return withProviderToken(
    options.tokenSource,
    { provider: "slack", installationId: options.installationId },
    async (token) => {
      let response: Response;
      try {
        response = await doFetch(`${SLACK_API_BASE}/${method}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(body),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (signal?.aborted) throw new SlackApiError(method, "timeout", false, { maybeDelivered: true });
        if (PRE_SEND_CODES.has(networkCode(error))) throw new SlackApiError(method, "connect_error", true);
        throw new SlackApiError(method, "network_error", false, { maybeDelivered: true });
      }
      if (response.status === 401) throw new ProviderUnauthorized(`slack ${method}: http 401`);
      if (response.status === 429 || response.status >= 500) {
        const wait = retryAfter(response);
        throw new SlackApiError(method, `http_${response.status}`, true, wait !== undefined ? { retryAfterMs: wait } : {});
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = (await response.json()) as Record<string, unknown>;
      } catch {
        throw new SlackApiError(method, `http_${response.status}_unparseable`, false);
      }
      if (parsed["ok"] === true) return parsed as T;
      const code = typeof parsed["error"] === "string" ? parsed["error"] : "unknown_error";
      if (UNAUTHORIZED_CODES.has(code)) throw new ProviderUnauthorized(`slack ${method}: ${code}`);
      const wait = code === "ratelimited" ? retryAfter(response) : undefined;
      throw new SlackApiError(method, code, TRANSIENT_CODES.has(code), wait !== undefined ? { retryAfterMs: wait } : {});
    },
  );
}

async function postSlackMessage(
  options: SlackClientOptions,
  input: PostMessageInput,
  signal?: AbortSignal,
): Promise<{ ts: string; channel: string }> {
  const result = await slackCall<{ ts?: unknown; channel?: unknown }>(
    options,
    "chat.postMessage",
    {
      channel: input.channel,
      text: input.text,
      unfurl_links: false,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    },
    signal,
  );
  if (typeof result.ts !== "string" || result.ts.length === 0) {
    throw new SlackApiError("chat.postMessage", "missing_ts", false, { maybeDelivered: true });
  }
  return {
    ts: result.ts,
    channel: typeof result.channel === "string" ? result.channel : input.channel,
  };
}
