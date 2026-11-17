import type { Method } from "./http.ts";
import type {
  Accepted,
  ApiToken,
  CreatedToken,
  Integration,
  IntegrationRoute,
  Page,
  Provider,
  RiskLevel,
  Schedule,
  ScheduleInput,
  ScopeKind,
  ServicePrincipal,
  WebhookEndpoint,
  WebhookEndpointWithSecret,
} from "./types.ts";

export type Send = <T>(method: Method, path: string, body?: unknown) => Promise<T>;

export const orgPath = (orgId: string, rest: string) => (orgId ? `/orgs/${encodeURIComponent(orgId)}${rest}` : rest);

const id = encodeURIComponent;

export interface RouteInput {
  scopeKind?: ScopeKind;
  scopeValue?: string | null;
  repositoryId?: string;
  triggerLabel?: string;
  enabled?: boolean;
}

export interface SchedulePreview {
  cron: string;
  timezone: string;
  nextFireTimes: string[];
}

export function automationsClient(send: Send) {
  return {
    async listIntegrations(orgId: string): Promise<Integration[]> {
      return (await send<Page<Integration>>("GET", orgPath(orgId, "/integrations"))).items;
    },
    async connectIntegration(orgId: string, input: { provider: Provider; installationId: string }): Promise<Integration> {
      return (await send<{ connection: Integration }>("POST", orgPath(orgId, "/integrations"), input)).connection;
    },
    async disconnectIntegration(orgId: string, integrationId: string): Promise<void> {
      await send("DELETE", orgPath(orgId, `/integrations/${id(integrationId)}`));
    },
    async addIntegrationRoute(orgId: string, integrationId: string, input: RouteInput): Promise<IntegrationRoute> {
      return (await send<{ route: IntegrationRoute }>("POST", orgPath(orgId, `/integrations/${id(integrationId)}/routes`), input)).route;
    },
    async updateIntegrationRoute(
      orgId: string,
      integrationId: string,
      routeId: string,
      input: Pick<RouteInput, "repositoryId" | "triggerLabel" | "enabled">,
    ): Promise<IntegrationRoute> {
      return (await send<{ route: IntegrationRoute }>("PATCH", orgPath(orgId, `/integrations/${id(integrationId)}/routes/${id(routeId)}`), input)).route;
    },
    async deleteIntegrationRoute(orgId: string, integrationId: string, routeId: string): Promise<void> {
      await send("DELETE", orgPath(orgId, `/integrations/${id(integrationId)}/routes/${id(routeId)}`));
    },

    async listSchedules(orgId: string, cursor?: string): Promise<Page<Schedule>> {
      return send("GET", orgPath(orgId, `/schedules${cursor ? `?cursor=${id(cursor)}` : ""}`));
    },
    async previewSchedule(orgId: string, cron: string, timezone: string, count = 3): Promise<SchedulePreview> {
      const q = new URLSearchParams({ cron, timezone, count: String(count) });
      return send("GET", orgPath(orgId, `/schedules/preview?${q}`));
    },
    async createSchedule(orgId: string, input: ScheduleInput): Promise<Schedule> {
      return (await send<{ schedule: Schedule }>("POST", orgPath(orgId, "/schedules"), input)).schedule;
    },
    async updateSchedule(orgId: string, scheduleId: string, input: ScheduleInput): Promise<Schedule> {
      return (await send<{ schedule: Schedule }>("PATCH", orgPath(orgId, `/schedules/${id(scheduleId)}`), input)).schedule;
    },
    async deleteSchedule(orgId: string, scheduleId: string): Promise<void> {
      await send("DELETE", orgPath(orgId, `/schedules/${id(scheduleId)}`));
    },
    async fireSchedule(orgId: string, scheduleId: string): Promise<Accepted & { taskId: string; engineeringRunId: string }> {
      return send("POST", orgPath(orgId, `/schedules/${id(scheduleId)}/fire`));
    },

    async listWebhookEndpoints(orgId: string): Promise<WebhookEndpoint[]> {
      return (await send<Page<WebhookEndpoint>>("GET", orgPath(orgId, "/webhook-endpoints"))).items;
    },
    async createWebhookEndpoint(
      orgId: string,
      input: { name: string; repositoryId: string; defaultRiskLevel?: RiskLevel },
    ): Promise<WebhookEndpointWithSecret> {
      const { endpoint, secret } = await send<WebhookEndpointWithSecret>("POST", orgPath(orgId, "/webhook-endpoints"), input);
      return { endpoint, secret };
    },
    async updateWebhookEndpoint(
      orgId: string,
      endpointId: string,
      input: { name?: string; enabled?: boolean; defaultRiskLevel?: RiskLevel },
    ): Promise<WebhookEndpoint> {
      return (await send<{ endpoint: WebhookEndpoint }>("PATCH", orgPath(orgId, `/webhook-endpoints/${id(endpointId)}`), input)).endpoint;
    },
    async deleteWebhookEndpoint(orgId: string, endpointId: string): Promise<void> {
      await send("DELETE", orgPath(orgId, `/webhook-endpoints/${id(endpointId)}`));
    },
    async rotateWebhookEndpoint(orgId: string, endpointId: string): Promise<WebhookEndpointWithSecret> {
      const { endpoint, secret } = await send<WebhookEndpointWithSecret>("POST", orgPath(orgId, `/webhook-endpoints/${id(endpointId)}/rotate`));
      return { endpoint, secret };
    },

    async listServicePrincipals(orgId: string): Promise<ServicePrincipal[]> {
      return (await send<Page<ServicePrincipal>>("GET", orgPath(orgId, "/service-principals"))).items;
    },
    async createServicePrincipal(orgId: string, input: { name: string; role: string }): Promise<ServicePrincipal> {
      return (await send<{ servicePrincipal: ServicePrincipal }>("POST", orgPath(orgId, "/service-principals"), input)).servicePrincipal;
    },
    async deleteServicePrincipal(orgId: string, principalId: string): Promise<void> {
      await send("DELETE", orgPath(orgId, `/service-principals/${id(principalId)}`));
    },
    async listServiceTokens(orgId: string, principalId: string): Promise<ApiToken[]> {
      return (await send<Page<ApiToken>>("GET", orgPath(orgId, `/service-principals/${id(principalId)}/tokens`))).items;
    },
    async createServiceToken(
      orgId: string,
      principalId: string,
      input: { name: string; preset?: string; permissions?: string[]; expiresAt?: string | null },
    ): Promise<CreatedToken> {
      const { token, secret } = await send<CreatedToken>("POST", orgPath(orgId, `/service-principals/${id(principalId)}/tokens`), input);
      return { token, secret };
    },
    async revokeServiceToken(orgId: string, principalId: string, tokenId: string): Promise<void> {
      await send("DELETE", orgPath(orgId, `/service-principals/${id(principalId)}/tokens/${id(tokenId)}`));
    },
  };
}

export type AutomationsApi = ReturnType<typeof automationsClient>;
