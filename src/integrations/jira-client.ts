

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { selectJiraSitesByWebhookIds } from "./stores/jira-store.js";
import { ProviderUnauthorized } from "./errors.js";
import { withProviderToken, type ProviderTokenSource } from "./token-source.js";

export type Queryable = Pool | PoolClient;
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const JIRA_API_BASE = "https://api.atlassian.com";

export const JIRA_WEBHOOK_EVENTS = ["jira:issue_created", "jira:issue_updated"] as const;

export const JIRA_INTERACTIVE_TIMEOUT_MS = 5_000;

export const JIRA_WEBHOOK_SECRET_ENV = "WINDKEEL_JIRA_WEBHOOK_SECRET";

export const JWT_LEEWAY_SECONDS = 60;

export const JWT_MAX_LIFETIME_SECONDS = 3600;

export type JwtVerdict = { ok: true; claims: Record<string, unknown> } | { ok: false; reason: string };

export function verifyJiraWebhookJwt(
  authorization: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): JwtVerdict {
  try {
    if (!secret) return { ok: false, reason: "no secret" };
    const match = /^(?:Bearer|JWT)\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(
      (authorization ?? "").trim(),
    );
    if (!match) return { ok: false, reason: "missing or malformed bearer token" };
    const [, headerPart, payloadPart, signaturePart] = match as unknown as [string, string, string, string];
    const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as Record<string, unknown>;
    if (header["alg"] !== "HS256") return { ok: false, reason: "unsupported alg" };
    const expected = createHmac("sha256", secret).update(`${headerPart}.${payloadPart}`).digest();
    const received = Buffer.from(signaturePart, "base64url");
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      return { ok: false, reason: "bad signature" };
    }
    const claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as unknown;
    if (typeof claims !== "object" || claims === null || Array.isArray(claims)) {
      return { ok: false, reason: "malformed claims" };
    }
    const c = claims as Record<string, unknown>;
    const exp = c["exp"];
    if (typeof exp !== "number" || nowSeconds > exp + JWT_LEEWAY_SECONDS) {
      return { ok: false, reason: "expired" };
    }
    if (exp - nowSeconds > JWT_MAX_LIFETIME_SECONDS + JWT_LEEWAY_SECONDS) {
      return { ok: false, reason: "lifetime too long" };
    }
    const iat = c["iat"];
    if (typeof iat === "number") {
      if (iat > nowSeconds + JWT_LEEWAY_SECONDS) return { ok: false, reason: "issued in the future" };
      if (exp - iat > JWT_MAX_LIFETIME_SECONDS) return { ok: false, reason: "lifetime too long" };
    }
    return { ok: true, claims: c };
  } catch {
    return { ok: false, reason: "malformed token" };
  }
}

export function signJiraWebhookJwt(claims: Record<string, unknown>, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export function jiraCloudIdFromSelf(self: unknown): string | null {
  if (typeof self !== "string") return null;
  const direct = /^https:\/\/api\.atlassian\.com\/ex\/jira\/([^/]+)\//.exec(self);
  if (!direct?.[1]) return null;
  try {
    return decodeURIComponent(direct[1]);
  } catch {
    return null;
  }
}

export function jiraSiteOrigin(self: unknown): string | null {
  if (typeof self !== "string") return null;
  try {
    const url = new URL(self);
    return url.hostname === "api.atlassian.com" ? null : url.origin;
  } catch {
    return null;
  }
}

function originOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export class JiraApiError extends Error {
  override readonly name = "JiraApiError";
  constructor(
    readonly operation: string,
    readonly status: number,
  ) {
    super(`Jira ${operation} failed with HTTP ${status}`);
  }
}

export class JiraTimeoutError extends Error {
  override readonly name = "JiraTimeoutError";
  constructor(operation: string) {
    super(`Jira ${operation} timed out`);
  }
}

export interface JiraWebhook {
  id: number;
  jqlFilter: string | null;
  expirationDate: number | null;
}

export interface JiraCallOptions {
  fetch?: FetchLike | undefined;

  timeoutMs?: number | undefined;

  signal?: AbortSignal | undefined;
}

function boundedSignal(options: JiraCallOptions): AbortSignal {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? JIRA_INTERACTIVE_TIMEOUT_MS);
  return options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

export class JiraClient {
  private readonly fetchImpl: FetchLike;
  constructor(
    private readonly cloudId: string,
    private readonly token: string,
    private readonly options: JiraCallOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  private url(path: string): string {
    return `${JIRA_API_BASE}/ex/jira/${encodeURIComponent(this.cloudId)}${path}`;
  }

  private async call(operation: string, method: string, url: string, body?: unknown): Promise<unknown> {
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: boundedSignal(this.options),
      });
      if (response.status === 401) throw new ProviderUnauthorized(`Jira ${operation} answered 401`);
      if (!response.ok) throw new JiraApiError(operation, response.status);
      if (response.status === 204) return null;
      const text = await response.text();
      return text.length === 0 ? null : (JSON.parse(text) as unknown);
    } catch (error) {
      if (isAbort(error)) throw new JiraTimeoutError(operation);
      throw error;
    }
  }

  async listWebhooks(): Promise<JiraWebhook[]> {
    const out: JiraWebhook[] = [];
    for (let startAt = 0, pages = 0; pages < 20; pages += 1) {
      const page = (await this.call(
        "list webhooks",
        "GET",
        this.url(`/rest/api/3/webhook?startAt=${startAt}&maxResults=100`),
      )) as { values?: unknown[]; isLast?: boolean } | null;
      const values = Array.isArray(page?.values) ? page.values : [];
      for (const v of values) {
        const w = v as { id?: unknown; jqlFilter?: unknown; expirationDate?: unknown };
        if (typeof w.id !== "number") continue;
        out.push({
          id: w.id,
          jqlFilter: typeof w.jqlFilter === "string" ? w.jqlFilter : null,
          expirationDate: typeof w.expirationDate === "number" ? w.expirationDate : null,
        });
      }
      if (page?.isLast !== false || values.length === 0) break;
      startAt += values.length;
    }
    return out;
  }

  async registerWebhooks(url: string, jqlFilters: readonly string[]): Promise<number[]> {
    const result = (await this.call("register webhook", "POST", this.url("/rest/api/3/webhook"), {
      url,
      webhooks: jqlFilters.map((jqlFilter) => ({
        jqlFilter,
        events: [...JIRA_WEBHOOK_EVENTS],
        fieldIdsFilter: ["labels"],
      })),
    })) as { webhookRegistrationResult?: Array<{ createdWebhookId?: unknown; errors?: unknown }> } | null;
    const results = result?.webhookRegistrationResult ?? [];
    const ids = results.map((r) => r?.createdWebhookId).filter((id): id is number => typeof id === "number");
    if (ids.length !== jqlFilters.length) {

      const n = results.reduce((sum, r) => sum + (Array.isArray(r?.errors) ? r.errors.length : 0), 0);
      if (ids.length > 0) await this.deleteWebhooks(ids).catch(() => {});
      throw new Error(`Jira refused the webhook registration (${n} error${n === 1 ? "" : "s"})`);
    }
    return ids;
  }

  async refreshWebhooks(ids: number[]): Promise<number> {
    const result = (await this.call("refresh webhooks", "PUT", this.url("/rest/api/3/webhook/refresh"), {
      webhookIds: ids,
    })) as { expirationDate?: unknown } | null;
    if (typeof result?.expirationDate !== "number") throw new Error("Jira did not say when the webhooks expire");
    return result.expirationDate;
  }

  async deleteWebhooks(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await this.call("delete webhooks", "DELETE", this.url("/rest/api/3/webhook"), { webhookIds: ids });
  }

  async listProjectKeys(deadline?: number): Promise<string[]> {
    const keys: string[] = [];
    for (let startAt = 0, pages = 0; pages < 50; pages += 1) {
      if (deadline !== undefined && performance.now() >= deadline) {
        throw new JiraTimeoutError("list projects (the sweep's time budget is spent)");
      }
      const page = (await this.call(
        "list projects",
        "GET",
        this.url(`/rest/api/3/project/search?startAt=${startAt}&maxResults=50`),
      )) as { values?: Array<{ key?: unknown }>; isLast?: boolean } | null;
      const values = Array.isArray(page?.values) ? page.values : [];
      for (const p of values) if (typeof p.key === "string") keys.push(p.key);
      if (page?.isLast !== false || values.length === 0) break;
      startAt += values.length;
    }
    return keys;
  }

  async addComment(issueKey: string, body: unknown): Promise<void> {
    await this.call(
      "add comment",
      "POST",
      this.url(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`),
      { body },
    );
  }

  async recentComments(issueKey: string): Promise<unknown[]> {
    const page = (await this.call(
      "list comments",
      "GET",
      this.url(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?orderBy=-created&maxResults=100`),
    )) as { comments?: Array<{ body?: unknown }> } | null;
    return Array.isArray(page?.comments) ? page.comments.map((c) => c.body) : [];
  }
}

export async function jiraSiteUrl(token: string, cloudId: string, options: JiraCallOptions = {}): Promise<string | null> {
  try {
    const response = await (options.fetch ?? fetch)(`${JIRA_API_BASE}/oauth/token/accessible-resources`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: boundedSignal(options),
    });
    if (response.status === 401) throw new ProviderUnauthorized("Jira accessible-resources answered 401");
    if (!response.ok) throw new JiraApiError("list accessible resources", response.status);
    const resources = (await response.json()) as Array<{ id?: unknown; url?: unknown }>;
    const found = Array.isArray(resources) ? resources.find((r) => r.id === cloudId) : undefined;
    return typeof found?.url === "string" ? found.url.replace(/\/+$/, "") : null;
  } catch (error) {
    if (isAbort(error)) throw new JiraTimeoutError("list accessible resources");
    throw error;
  }
}

export interface JiraTarget {
  tokens: ProviderTokenSource;
  installationId: string;
  cloudId: string;
  fetch?: FetchLike | undefined;

  timeoutMs?: number | undefined;
}

function bounded<T>(work: Promise<T>, operation: string, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const fail = (): void => reject(new JiraTimeoutError(operation));
    if (signal?.aborted) return fail();
    const timer = setTimeout(fail, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      fail();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function withJiraClient<T>(
  target: JiraTarget,
  fn: (client: JiraClient, token: string) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const timeoutMs = target.timeoutMs ?? JIRA_INTERACTIVE_TIMEOUT_MS;
  const tokens: ProviderTokenSource = {
    getToken: (req) => bounded(target.tokens.getToken(req), "token fetch", timeoutMs, signal),
    describeInstallation: (req) => target.tokens.describeInstallation(req),
    invalidate: (req) => target.tokens.invalidate(req),
  };
  return withProviderToken(tokens, { provider: "jira", installationId: target.installationId }, (token) =>
    fn(new JiraClient(target.cloudId, token, { fetch: target.fetch, timeoutMs, signal }), token),
  );
}

export async function resolveJiraCloudId(db: Queryable, payload: JiraWebhookPayload): Promise<string | null> {
  const self = payload.issue?.self;
  const direct = jiraCloudIdFromSelf(self);
  if (direct) return direct;

  const ids = Array.isArray(payload.matchedWebhookIds)
    ? payload.matchedWebhookIds.filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id))
    : [];
  if (ids.length === 0) return null;
  const { rows } = await selectJiraSitesByWebhookIds(db, ids);
  const origin = jiraSiteOrigin(self);
  if (origin === null) return null;
  const clouds = new Set(rows.filter((r) => originOf(r.site_url) === origin).map((r) => r.cloud_id));
  return clouds.size === 1 ? [...clouds][0]! : null;
}

export interface JiraWebhookPayload {
  webhookEvent?: string;
  issue_event_type_name?: string;
  timestamp?: number;
  matchedWebhookIds?: unknown[];
  issue?: {
    id?: string;
    key?: string;
    self?: string;
    fields?: {
      summary?: string;
      description?: unknown;
      labels?: unknown[];
      project?: { key?: string; id?: string };
    };
  };
  changelog?: {
    items?: Array<{ field?: string; fieldId?: string; fromString?: string | null; toString?: string | null }>;
  };
}
