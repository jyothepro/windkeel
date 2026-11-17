import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { EngineeringRun } from "../factory/repositories.js";
import { getRepository, pullRequestUrl } from "../factory/repository-entity.js";
import { defaultLog, describeError, redactSecrets, type IntakeLog } from "../factory/log.js";
import { registerSourceNotifier, type NotifiedTask, type RunOutcome, type SourceNotifier } from "../intake/notifiers.js";
import { isVerified, verdictLine, VERIFYING_TEXT } from "../intake/verdict.js";
import { resolveConnection } from "./connections.js";
import { ProviderUnauthorized } from "./errors.js";
import { withProviderToken, type ProviderTokenSource } from "./token-source.js";

export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

export const LINEAR_SOURCE_TYPE = "linear";

type Fetch = typeof fetch;
type Log = IntakeLog;

export const LINEAR_START_COMMENT_TIMEOUT_MS = 5_000;

export class LinearGraphQLError extends Error {
  override readonly name = "LinearGraphQLError";
  readonly codes: string[];
  readonly status: number;
  constructor(codes: string[], status: number, what = "failed") {
    super(`linear commentCreate ${what} (status ${status})${codes.length > 0 ? `: ${codes.join(", ")}` : ""}`);
    this.codes = codes;
    this.status = status;
  }
}

class LinearTimeoutError extends Error {
  override readonly name = "LinearTimeoutError";
  constructor() {
    super("linear commentCreate did not finish in time");
  }
}

export interface LinearClientDeps {
  tokenSource: ProviderTokenSource;
  fetch?: Fetch;
}

export interface LinearCommentInput {
  installationId: string;
  issueId: string;
  body: string;
  commentId: string;
  signal?: AbortSignal;
}

const COMMENT_CREATE = `mutation WindkeelCommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id } }
}`;

export async function linearCommentCreate(
  deps: LinearClientDeps,
  input: LinearCommentInput,
): Promise<{ posted: boolean }> {
  return raceAbort(commentCreate(deps, input), input.signal);
}

async function commentCreate(deps: LinearClientDeps, input: LinearCommentInput): Promise<{ posted: boolean }> {
  const doFetch = deps.fetch ?? fetch;
  return withProviderToken(deps.tokenSource, { provider: "linear", installationId: input.installationId }, async (token) => {
    const response = await doFetch(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        query: COMMENT_CREATE,
        variables: { input: { id: input.commentId, issueId: input.issueId, body: input.body } },
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (response.status === 401) throw new ProviderUnauthorized("linear rejected the token");

    let json: GraphQLResponseShape | null;
    try {
      json = (await response.json()) as GraphQLResponseShape | null;
    } catch {
      json = null;
    }
    const errors: GraphQLErrorShape[] = Array.isArray(json?.errors) ? json.errors : [];
    if (errors.length > 0) {
      const codes = errors.map(errorCode);
      if (codes.some((code) => /authenticat/i.test(code))) {
        throw new ProviderUnauthorized("linear rejected the token");
      }
      if (errors.length === 1 && isDuplicateError(errors[0]!)) return { posted: false };
      throw new LinearGraphQLError(codes, response.status);
    }
    if (!response.ok) throw new LinearGraphQLError([], response.status);
    if (json?.data?.commentCreate?.success !== true) {
      throw new LinearGraphQLError([], response.status, "did not report success");
    }
    return { posted: true };
  });
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(new LinearTimeoutError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new LinearTimeoutError());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

interface GraphQLResponseShape {
  data?: { commentCreate?: { success?: boolean } | null } | null;
  errors?: GraphQLErrorShape[];
}

interface GraphQLErrorShape {
  message?: unknown;
  extensions?: { code?: unknown; type?: unknown; userPresentableMessage?: unknown };
}

function errorCode(error: GraphQLErrorShape): string {
  const code = error.extensions?.code ?? error.extensions?.type;
  return typeof code === "string" && code.length > 0 ? code : "UNKNOWN";
}

export function isDuplicateError(error: GraphQLErrorShape): boolean {
  return error.extensions?.code === "INVALID_INPUT" && /^Entity already exists\b/i.test(String(error.message ?? ""));
}

export function deterministicUuid(...parts: string[]): string {
  const hex = createHash("sha256").update(["orqon", ...parts].join("\u0000")).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function runLink(runId: string, consoleUrl: string | undefined): string {
  const base = consoleUrl?.trim().replace(/\/+$/, "");
  return base ? `${base}/runs/${runId}` : `run \`${runId}\``;
}

export interface LinearStartCommentInput {
  installationId: string;
  issueId: string;
  runId: string;
  consoleUrl?: string | undefined;
  signal?: AbortSignal;
}

function startCommentBody(runId: string, consoleUrl: string | undefined): string {
  return `Windkeel started · ${runLink(runId, consoleUrl)}`;
}

export function postLinearStartComment(
  deps: LinearClientDeps,
  input: LinearStartCommentInput,
): Promise<{ posted: boolean }> {
  return linearCommentCreate(deps, {
    installationId: input.installationId,
    issueId: input.issueId,
    body: startCommentBody(input.runId, input.consoleUrl),
    commentId: deterministicUuid("linear-comment", input.runId, "started"),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

export interface LinearNotifierDeps extends LinearClientDeps {
  pool: Pool;
  consoleUrl?: () => string | undefined;
  log?: Log;
}

export interface LinearSourceContext {
  organizationId: string;
  issueId: string;
  identifier?: string;
  url?: string;
  teamId?: string;
}

function linearSourceContextOf(task: NotifiedTask): LinearSourceContext | null {
  const ctx = (task as { sourceContext?: unknown }).sourceContext;
  if (!ctx || typeof ctx !== "object") return null;
  const { organizationId, issueId } = ctx as Record<string, unknown>;
  if (typeof organizationId !== "string" || typeof issueId !== "string") return null;
  return ctx as LinearSourceContext;
}

function outcomeCommentBody(
  outcome: RunOutcome,
  facts: { runId: string; consoleUrl: string | undefined; pullRequestUrl: string | null },
): string | null {
  const link = runLink(facts.runId, facts.consoleUrl);
  if (outcome.kind === "progress") return `${VERIFYING_TEXT} · ${link}`;
  if (outcome.kind === "started") return null;
  const reason = outcome.reason ? redactSecrets(outcome.reason).slice(0, 500) : null;
  const verdict = outcome.verdict !== undefined ? verdictLine(outcome.verdict) : null;
  switch (outcome.state) {
    case "WAITING_FOR_HUMAN":
      if (facts.pullRequestUrl && isVerified(outcome.verdict)) {
        return `${verdict} · draft PR ${facts.pullRequestUrl} · ${link}`;
      }
      return `Windkeel is waiting for a human${verdict ? ` — ${verdict}` : ""}${facts.pullRequestUrl ? ` · draft PR ${facts.pullRequestUrl}` : ""} · ${link}`;
    case "WAITING_FOR_APPROVAL":
      return (
        `Windkeel found no acceptance criteria in this issue, generated some, and needs them approved ` +
        `before it continues · ${link}`
      );
    case "COMPLETED":
      return facts.pullRequestUrl
        ? `Windkeel finished: ${facts.pullRequestUrl} · ${link}`
        : `Windkeel finished · ${link}`;
    case "CANCELLED":
      return `Windkeel run cancelled${reason ? `: ${reason}` : ""} · ${link}`;
    case "FAILED":
      return `Windkeel run failed${verdict ? ` — ${verdict}` : ""}${reason ? `: ${reason}` : ""} · ${link}`;
    case "MAX_REPAIR_ATTEMPTS_REACHED":
      return `Windkeel stopped after its repair attempts ran out${verdict ? ` — ${verdict}` : ""}${reason ? `: ${reason}` : ""} · ${link}`;
    default:
      return null;
  }
}

export function createLinearNotifier(deps: LinearNotifierDeps): SourceNotifier {
  const log = deps.log ?? defaultLog;
  const consoleUrl = deps.consoleUrl ?? (() => process.env["WINDKEEL_CONSOLE_URL"]?.trim() || undefined);
  return {
    sourceType: LINEAR_SOURCE_TYPE,
    async notify(task: NotifiedTask, run: EngineeringRun, outcome: RunOutcome, signal?: AbortSignal): Promise<void> {
      if (outcome.kind === "started") return;
      try {
        const context = linearSourceContextOf(task);
        if (!context) {
          log("linear notification skipped", { engineeringRunId: run.id, reason: "no_source_context" });
          return;
        }
        const connection = await resolveConnection(deps.pool, "linear", context.organizationId);
        if (!connection) {
          log("linear notification skipped", { engineeringRunId: run.id, reason: "not_connected" });
          return;
        }
        let prUrl: string | null = null;
        if (run.prNumber !== null) {
          const repository = await getRepository(deps.pool, task.repositoryId);
          if (repository) prUrl = pullRequestUrl(repository, run.prNumber);
        }
        const body = outcomeCommentBody(outcome, { runId: run.id, consoleUrl: consoleUrl(), pullRequestUrl: prUrl });
        if (!body) return;
        const result = await linearCommentCreate(deps, {
          installationId: connection.installationId,
          issueId: context.issueId,
          body,
          commentId:
            outcome.kind === "progress"
              ? deterministicUuid("linear-comment", run.id, "verifying")
              : deterministicUuid("linear-comment", outcome.transitionId),
          ...(signal ? { signal } : {}),
        });
        if (!result.posted) log("linear notification already posted", { engineeringRunId: run.id, state: outcome.state });
      } catch (error) {
        log("linear notification failed", { engineeringRunId: run.id, state: outcome.state, ...describeError(error) });
      }
    },
  };
}

export function registerLinearNotifier(deps: LinearNotifierDeps): void {
  registerSourceNotifier(createLinearNotifier(deps));
}
