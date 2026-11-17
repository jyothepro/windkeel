

import type { ErrorBody, Page } from "@windkeel/api-contract";
import type { CredentialSource, ResolvedConfig } from "./credentials.js";
import { MissingApiConfigError, resolveApiConfig } from "./credentials.js";
import { ApiDisabledError, ApiError, fieldOf, safeJson } from "./errors.js";
import type {
  ApiTokenView,
  BatchDetail,
  BatchInput,
  BatchView,
  CaptureListing,
  CaptureView,
  CommandAck,
  CreatedToken,
  CreditBalanceReport,
  CreditStatement,
  DeviceAuthorization,
  EventPage,
  GuidanceEntry,
  IntegrationRouteView,
  IntegrationView,
  InvitationView,
  MemberView,
  MetricsReport,
  ModelChoiceInput,
  ModelCredentialView,
  ModelPolicyView,
  PlaybookView,
  ReapResult,
  ReapableSandbox,
  RepositoryView,
  RunEvent,
  RunReceipt,
  RunSummary,
  ScheduleInput,
  ScheduleView,
  SecretEntry,
  SelfView,
  ServicePrincipalView,
  UsageReport,
  WebhookEndpointView,
} from "./views.js";

export { PERMISSIONS, PRESETS, presetFor, effectivePermissions } from "./permissions.js";
export type { Permission } from "./permissions.js";
export { ApiError, ApiDisabledError, adviceFor } from "./errors.js";
export type {
  RunEvent,
  EventPage,
  BatchInput,
  BatchProgressView,
  BatchView,
  BatchItemView,
  BatchDetail,
  ScheduleInput,
  ScheduleView,
  IntegrationView,
  ModelChoiceInput,
  PlaybookView,
  ModelPolicyView,
  ModelCredentialView,
  WebhookEndpointView,
  IntegrationRouteView,
  RunSummary,
  GuidanceEntry,
  SecretEntry,
  CommandAck,
  RepositoryView,
  UsageReport,
  RunReceipt,
  CreditBalanceReport,
  CreditStatement,
  MetricsReport,
  ReapableSandbox,
  ReapResult,
  CaptureView,
  CaptureListing,
  SelfView,
  ApiTokenView,
  CreatedToken,
  DeviceAuthorization,
  ServicePrincipalView,
  MemberView,
  InvitationView,
} from "./views.js";

export { MissingApiConfigError };

export interface ApiConfig {
  baseUrl: string;

  token: string;

  org?: string;

  fetch?: typeof globalThis.fetch;

  source?: Omit<ResolvedConfig, "token" | "baseUrl" | "org">;
}

const ORG_SCOPED = /^\/v1\/(runs|tasks|queue|metrics|repositories|secrets|sandboxes|integrations|webhook-endpoints|model-credentials|model-policy|usage|budget|billing)(\/|$)/;

export function scopePath(path: string, org: string | undefined): string {
  if (!org || !ORG_SCOPED.test(path)) return path;
  return `/v1/orgs/${encodeURIComponent(org)}${path.slice("/v1".length)}`;
}

export type { ErrorBody, Page };

export class WindkeelApi {
  readonly baseUrl: string;
  readonly org: string | undefined;
  readonly source: ApiConfig["source"];
  private readonly token: string;
  private readonly doFetch: typeof globalThis.fetch;

  constructor(config: ApiConfig) {

    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.token = config.token;
    this.org = config.org;
    this.source = config.source;
    this.doFetch = config.fetch ?? globalThis.fetch;
  }

  get tokenSource(): CredentialSource {
    return this.source?.tokenSource ?? "explicit";
  }

  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    overrides: { baseUrl?: string; token?: string; org?: string; fetch?: typeof globalThis.fetch } = {},
  ): WindkeelApi {
    const { fetch, ...rest } = overrides;
    const { baseUrl, token, org, ...source } = resolveApiConfig(env, rest);
    return new WindkeelApi({
      baseUrl,
      token,
      source,
      ...(org ? { org } : {}),
      ...(fetch ? { fetch } : {}),
    });
  }

  withOrg(org: string | undefined): WindkeelApi {
    return new WindkeelApi({
      baseUrl: this.baseUrl,
      token: this.token,
      fetch: this.doFetch,
      ...(org ? { org } : {}),
      ...(this.source ? { source: this.source } : {}),
    });
  }

  async get<T>(path: string, query: Record<string, string | undefined> = {}): Promise<T> {
    return this.request<T>("GET", path, query);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, {}, body);
  }

  async put<T>(path: string, body?: unknown, query: Record<string, string | undefined> = {}): Promise<T> {
    return this.request<T>("PUT", path, query, body);
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, {}, body);
  }

  async delete<T>(path: string, query: Record<string, string | undefined> = {}): Promise<T> {
    return this.request<T>("DELETE", path, query);
  }

  private async request<T>(
    method: string,
    path: string,
    query: Record<string, string | undefined>,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${scopePath(path, this.org)}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const response = await this.doFetch(url, {
      method,
      headers: {
        ...(this.token === "" ? {} : { authorization: `Bearer ${this.token}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),

      redirect: "manual",
    });

    if (response.status === 302) {
      const location = response.headers.get("location");
      if (location) return { url: location } as T;
    }
    const text = await response.text();
    const parsed = text === "" ? undefined : safeJson(text);

    if (!response.ok) {
      const code = fieldOf(parsed, "code") ?? `http_${response.status}`;
      const message = fieldOf(parsed, "error") ?? `${method} ${path} failed with ${response.status}`;
      const body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
      throw code === "api_disabled"
        ? new ApiDisabledError(response.status, code, message, body)
        : new ApiError(response.status, code, message, body);
    }
    return parsed as T;
  }

  async exportAuditPart(
    query: { after?: string; before?: string; format: "jsonl" | "csv"; cursor?: string; action?: string },
    org?: string,
  ): Promise<{ body: string; nextCursor: string | null; count: number }> {
    const path = org ? `${orgPath(org)}/audit-events/export` : "/v1/account/audit-events/export";
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value);
    const response = await this.doFetch(url, {
      method: "GET",
      headers: this.token === "" ? {} : { authorization: `Bearer ${this.token}` },
      redirect: "manual",
    });
    const text = await response.text();
    if (!response.ok) {
      const parsed = text === "" ? undefined : safeJson(text);
      const code = fieldOf(parsed, "code") ?? `http_${response.status}`;
      const message = fieldOf(parsed, "error") ?? `GET ${path} failed with ${response.status}`;
      throw new ApiError(response.status, code, message, typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {});
    }
    return {
      body: text,
      nextCursor: response.headers.get("x-windkeel-next-cursor"),
      count: Number(response.headers.get("x-windkeel-export-count") ?? 0),
    };
  }

  verifyAudit(): Promise<{ ok: boolean; checked: number; brokenAt?: { seq: number; id: string; reason: string } }> {
    return this.get("/v1/account/audit-events/verify");
  }

  self(): Promise<SelfView> {
    return this.get("/v1/self");
  }

  listTokens(): Promise<{ items: ApiTokenView[] }> {
    return this.get("/v1/tokens");
  }

  createToken(spec: {
    name: string;
    preset?: string;
    permissions?: string[];
    organizationId?: string;
    expiresInDays?: number;
  }): Promise<CreatedToken> {
    return this.post("/v1/tokens", spec);
  }

  revokeToken(tokenId: string): Promise<{ token: ApiTokenView }> {
    return this.post(`/v1/tokens/${encodeURIComponent(tokenId)}/revoke`);
  }

  startDeviceLogin(spec: {
    machineName: string;
    preset?: string;
    permissions?: string[];
    admin?: boolean;
  }): Promise<DeviceAuthorization> {
    return this.post("/v1/auth/device", spec);
  }

  pollDeviceToken(deviceCode: string): Promise<CreatedToken> {
    return this.post("/v1/auth/device/token", { deviceCode });
  }

  listMembers(orgId: string): Promise<{ items: MemberView[] }> {
    return this.get(`${orgPath(orgId)}/members`);
  }

  listInvitations(orgId: string): Promise<{ items: InvitationView[] }> {
    return this.get(`${orgPath(orgId)}/invitations`);
  }

  invite(orgId: string, invitation: { githubLogin: string; role: string }): Promise<Record<string, unknown>> {
    return this.post(`${orgPath(orgId)}/invitations`, invitation);
  }

  setMemberRole(orgId: string, principalId: string, role: string): Promise<Record<string, unknown>> {
    return this.post(`${orgPath(orgId)}/members/${encodeURIComponent(principalId)}/role`, { role });
  }

  removeMember(orgId: string, principalId: string): Promise<Record<string, unknown>> {
    return this.post(`${orgPath(orgId)}/members/${encodeURIComponent(principalId)}/delete`);
  }

  listServicePrincipals(orgId: string): Promise<{ items: ServicePrincipalView[] }> {
    return this.get(`${orgPath(orgId)}/service-principals`);
  }

  createServicePrincipal(orgId: string, spec: { name: string; role?: string }): Promise<{ servicePrincipal: ServicePrincipalView }> {
    return this.post(`${orgPath(orgId)}/service-principals`, spec);
  }

  deleteServicePrincipal(orgId: string, principalId: string): Promise<{ deleted: string; servicePrincipal: ServicePrincipalView }> {
    return this.post(`${orgPath(orgId)}/service-principals/${encodeURIComponent(principalId)}/delete`);
  }

  listServiceTokens(orgId: string, principalId: string): Promise<{ items: ApiTokenView[] }> {
    return this.get(`${orgPath(orgId)}/service-principals/${encodeURIComponent(principalId)}/tokens`);
  }

  createServiceToken(
    orgId: string,
    principalId: string,
    spec: { name: string; preset?: string; permissions?: string[]; expiresAt?: string },
  ): Promise<CreatedToken> {
    return this.post(`${orgPath(orgId)}/service-principals/${encodeURIComponent(principalId)}/tokens`, spec);
  }

  revokeServiceToken(orgId: string, principalId: string, tokenId: string): Promise<{ token: ApiTokenView }> {
    return this.post(
      `${orgPath(orgId)}/service-principals/${encodeURIComponent(principalId)}/tokens/${encodeURIComponent(tokenId)}/revoke`,
    );
  }

  health(): Promise<{ ok: boolean; database: string }> {
    return this.get("/v1/health");
  }

  listRuns(filter: { status?: string; repository?: string; task?: string; batch?: string; limit?: string; cursor?: string } = {}) {
    return this.get<Page<RunSummary>>("/v1/runs", filter);
  }

  getRun(runId: string): Promise<{ report: unknown; rendered: string; terminal: boolean; cursor: string; receipt?: RunReceipt }> {
    return this.get(`/v1/runs/${runId}`);
  }

  events(runId: string, after?: string, limit?: string): Promise<EventPage> {
    return this.get(`/v1/runs/${runId}/events`, { after, limit });
  }

  attempts(runId: string): Promise<Page<Record<string, unknown>>> {
    return this.get(`/v1/runs/${runId}/attempts`);
  }

  cost(runId: string): Promise<Record<string, unknown>> {
    return this.get(`/v1/runs/${runId}/cost`);
  }

  queue(): Promise<Page<RunSummary>> {
    return this.get("/v1/queue");
  }

  listTasks(filter: { repository?: string; status?: string; limit?: string; cursor?: string } = {}) {
    return this.get<Page<Record<string, unknown>>>("/v1/tasks", filter);
  }

  approve(runId: string) {
    return this.post<CommandAck>(`/v1/runs/${runId}/approve`);
  }

  cancel(runId: string, reason?: string) {
    return this.post<CommandAck>(`/v1/runs/${runId}/cancel`, reason === undefined ? undefined : { reason });
  }

  guide(runId: string, message: string) {
    return this.post<CommandAck>(`/v1/runs/${runId}/messages`, { message });
  }

  messages(runId: string): Promise<Page<GuidanceEntry>> {
    return this.get(`/v1/runs/${runId}/messages`);
  }

  listSecrets(repositoryId: string): Promise<Page<SecretEntry>> {
    return this.get(`/v1/repositories/${repositoryId}/secrets`);
  }

  setSecret(repositoryId: string, secret: { key: string; value: string; note?: string }) {
    return this.post<SecretEntry>(`/v1/repositories/${repositoryId}/secrets`, secret);
  }

  deleteSecret(repositoryId: string, key: string) {
    return this.post<{ deleted: string }>(
      `/v1/repositories/${repositoryId}/secrets/${encodeURIComponent(key)}/delete`,
    );
  }

  submitTask(spec: {
    repositoryId: string;
    title: string;
    description: string;
    riskLevel?: string;
    spendCapUsd?: number;
    wallClockCapSeconds?: number;

    models?: { maker?: string | ModelChoiceInput; checker?: string | ModelChoiceInput };

    playbook?: string;
  }) {
    return this.post<CommandAck>("/v1/tasks", spec);
  }

  listRepositories(cursor?: string): Promise<Page<RepositoryView>> {
    return this.get("/v1/repositories", { cursor });
  }

  metrics(): Promise<MetricsReport> {
    return this.get("/v1/metrics");
  }

  usage(period?: string): Promise<UsageReport> {
    return this.get("/v1/usage", { period });
  }

  billingBalance(): Promise<CreditBalanceReport> {
    return this.get("/v1/billing/balance");
  }

  billingStatement(period?: string): Promise<CreditStatement> {
    return this.get("/v1/billing/statement", { period });
  }

  async billingStatementCsv(period?: string): Promise<string> {
    const url = new URL(`${this.baseUrl}${scopePath("/v1/billing/statement", this.org)}`);
    url.searchParams.set("format", "csv");
    if (period) url.searchParams.set("period", period);
    const response = await this.doFetch(url, {
      method: "GET",
      headers: this.token === "" ? {} : { authorization: `Bearer ${this.token}` },
      redirect: "manual",
    });
    const text = await response.text();
    if (!response.ok) {
      const parsed = text === "" ? undefined : safeJson(text);
      const code = fieldOf(parsed, "code") ?? `http_${response.status}`;
      const message = fieldOf(parsed, "error") ?? `GET /v1/billing/statement failed with ${response.status}`;
      throw new ApiError(response.status, code, message, typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {});
    }
    return text;
  }

  receipt(runId: string): Promise<RunReceipt> {
    return this.get(`/v1/runs/${runId}/receipt`);
  }

  reapable(): Promise<Page<ReapableSandbox>> {
    return this.get("/v1/sandboxes/reapable");
  }

  reap(): Promise<ReapResult> {
    return this.post("/v1/sandboxes/reap");
  }

  capture(runId: string): Promise<CaptureView> {
    return this.post(`/v1/runs/${runId}/capture`);
  }

  captured(runId: string): Promise<CaptureListing> {
    return this.get(`/v1/runs/${runId}/capture`);
  }

  captureFileUrl(runId: string, path: string): Promise<{ url: string }> {
    return this.get(`/v1/runs/${runId}/capture/${path.split("/").map(encodeURIComponent).join("/")}`);
  }

  async download(url: string): Promise<Uint8Array> {
    const response = await this.doFetch(url);
    if (!response.ok) throw new ApiError(response.status, `http_${response.status}`, `download failed with ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  startRun(taskId: string) {
    return this.post<CommandAck>("/v1/runs", { taskId });
  }

  listIntegrations(): Promise<Page<IntegrationView>> {
    return this.get("/v1/integrations");
  }

  connectIntegration(provider: string, installationId: string): Promise<{ connection: IntegrationView }> {
    return this.post("/v1/integrations", { provider, installationId });
  }

  disconnectIntegration(integrationId: string): Promise<{ connection: IntegrationView }> {
    return this.delete(`/v1/integrations/${encodeURIComponent(integrationId)}`);
  }

  addIntegrationRoute(
    integrationId: string,
    route: { repositoryId: string; scopeKind?: string; scopeValue?: string; triggerLabel?: string; enabled?: boolean },
  ): Promise<{ route: IntegrationRouteView }> {
    return this.post(`/v1/integrations/${encodeURIComponent(integrationId)}/routes`, route);
  }

  updateIntegrationRoute(
    integrationId: string,
    routeId: string,
    change: { repositoryId?: string; triggerLabel?: string; enabled?: boolean },
  ): Promise<{ route: IntegrationRouteView }> {
    return this.patch(
      `/v1/integrations/${encodeURIComponent(integrationId)}/routes/${encodeURIComponent(routeId)}`,
      change,
    );
  }

  removeIntegrationRoute(integrationId: string, routeId: string): Promise<{ deleted: string }> {
    return this.delete(`/v1/integrations/${encodeURIComponent(integrationId)}/routes/${encodeURIComponent(routeId)}`);
  }

  listSchedules(): Promise<Page<ScheduleView>> {
    return this.get("/v1/schedules");
  }

  getSchedule(scheduleId: string): Promise<{ schedule: ScheduleView }> {
    return this.get(`/v1/schedules/${encodeURIComponent(scheduleId)}`);
  }

  createSchedule(input: ScheduleInput): Promise<{ schedule: ScheduleView }> {
    return this.post("/v1/schedules", input);
  }

  updateSchedule(scheduleId: string, change: Partial<ScheduleInput>): Promise<{ schedule: ScheduleView }> {
    return this.patch(`/v1/schedules/${encodeURIComponent(scheduleId)}`, change);
  }

  deleteSchedule(scheduleId: string): Promise<{ deleted: string }> {
    return this.delete(`/v1/schedules/${encodeURIComponent(scheduleId)}`);
  }

  fireSchedule(scheduleId: string): Promise<CommandAck & { taskId: string; enqueued: boolean }> {
    return this.post(`/v1/schedules/${encodeURIComponent(scheduleId)}/fire`);
  }

  previewSchedule(cron: string, timezone: string, count = 5): Promise<{ cron: string; timezone: string; nextFireTimes: string[] }> {
    return this.get("/v1/schedules/preview", { cron, timezone, count: String(count) });
  }

  listBatches(filter: { status?: string; limit?: string; cursor?: string } = {}): Promise<Page<BatchView>> {
    return this.get("/v1/batches", filter);
  }

  getBatch(batchId: string): Promise<BatchDetail> {
    return this.get(`/v1/batches/${encodeURIComponent(batchId)}`);
  }

  createBatch(input: BatchInput): Promise<BatchDetail & { accepted: boolean; batchId: string; started: number }> {
    return this.post("/v1/batches", input);
  }

  batchCommand(
    batchId: string,
    action: "pause" | "resume" | "cancel",
  ): Promise<BatchDetail & { accepted: boolean; batchId: string; started: number; cancelled?: Array<{ runId: string; outcome: string }> }> {
    return this.post(`/v1/batches/${encodeURIComponent(batchId)}/${action}`);
  }

  listWebhookEndpoints(): Promise<Page<WebhookEndpointView>> {
    return this.get("/v1/webhook-endpoints");
  }

  createWebhookEndpoint(spec: {
    name: string;
    repositoryId: string;
    defaultRiskLevel?: string;
  }): Promise<{ endpoint: WebhookEndpointView; secret: string }> {
    return this.post("/v1/webhook-endpoints", spec);
  }

  rotateWebhookEndpoint(endpointId: string): Promise<{ endpoint: WebhookEndpointView; secret: string }> {
    return this.post(`/v1/webhook-endpoints/${encodeURIComponent(endpointId)}/rotate`);
  }

  listModelCredentials(options: { includeRevoked?: boolean } = {}): Promise<Page<ModelCredentialView>> {
    return this.get("/v1/model-credentials", { include: options.includeRevoked ? "revoked" : undefined });
  }

  createModelCredential(input: {
    provider: string;
    label: string;
    value: string;
    baseUrl?: string;
    declaredVendor?: string;
  }): Promise<{ credential: ModelCredentialView; validation: string }> {
    return this.post("/v1/model-credentials", input);
  }

  rotateModelCredential(
    credentialId: string,
    value: string,
  ): Promise<{ credential: ModelCredentialView; validation: string }> {
    return this.put(`/v1/model-credentials/${encodeURIComponent(credentialId)}`, { value });
  }

  revokeModelCredential(credentialId: string): Promise<{ credential: ModelCredentialView }> {
    return this.delete(`/v1/model-credentials/${encodeURIComponent(credentialId)}`);
  }

  validateModelCredential(credentialId: string): Promise<{ credential: ModelCredentialView; validation: string }> {
    return this.post(`/v1/model-credentials/${encodeURIComponent(credentialId)}/validate`);
  }

  listPlaybooks(): Promise<{ items: PlaybookView[] }> {
    return this.get("/v1/playbooks");
  }

  getPlaybook(slugOrId: string): Promise<{ playbook: PlaybookView }> {
    return this.get(`/v1/playbooks/${encodeURIComponent(slugOrId)}`);
  }

  modelPolicy(repositoryId?: string): Promise<{ repositoryId: string | null; items: ModelPolicyView[] }> {
    return this.get("/v1/model-policy", { repositoryId });
  }

  setModelPolicy(
    change: { maker?: ModelChoiceInput; checker?: ModelChoiceInput },
    repositoryId?: string,
  ): Promise<{ repositoryId: string | null; items: ModelPolicyView[] }> {
    return this.put("/v1/model-policy", change, { repositoryId });
  }

  clearModelPolicy(options: { repositoryId?: string; role?: string } = {}): Promise<{ repositoryId: string | null; deleted: number }> {
    return this.delete("/v1/model-policy", options);
  }

  updateWebhookEndpoint(
    endpointId: string,
    patch: { name?: string; enabled?: boolean; defaultRiskLevel?: string },
  ): Promise<{ endpoint: WebhookEndpointView }> {
    return this.patch(`/v1/webhook-endpoints/${encodeURIComponent(endpointId)}`, patch);
  }

  deleteWebhookEndpoint(endpointId: string): Promise<{ deleted: string }> {
    return this.delete(`/v1/webhook-endpoints/${encodeURIComponent(endpointId)}`);
  }

  async *follow(
    runId: string,
    options: { after?: string; pollMs?: number; signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {},
  ): AsyncGenerator<RunEvent, { runStatus: string; cursor: string }, void> {
    const pollMs = options.pollMs ?? 2_000;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let cursor = options.after ?? "0";

    for (;;) {
      if (options.signal?.aborted) return { runStatus: "unknown", cursor };

      let page = await this.events(runId, cursor);

      for (;;) {
        for (const event of page.items) yield event;
        if (page.items.length > 0) cursor = page.endCursor ?? cursor;
        if (!page.hasNextPage) break;
        page = await this.events(runId, cursor);
      }

      if (page.terminal) return { runStatus: page.runStatus, cursor };
      await sleep(pollMs);
    }
  }
}

function orgPath(orgId: string): string {
  return `/v1/orgs/${encodeURIComponent(orgId)}`;
}
