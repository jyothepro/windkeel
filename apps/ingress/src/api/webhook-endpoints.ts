import type { Page } from "@windkeel/api-contract";
import { type IntegrationConnection, type IntegrationRoute } from "@windkeel/factory/integrations";
import { createWebhookEndpoint as storeCreateWebhookEndpoint, deleteWebhookEndpoint as storeDeleteWebhookEndpoint, deriveWebhookSecret, listWebhookEndpoints, rotateWebhookEndpoint as storeRotateWebhookEndpoint, updateWebhookEndpoint as storeUpdateWebhookEndpoint, usableWebhookSigningKey, type WebhookEndpoint } from "@windkeel/factory/intake";
import { type ApiDeps, type ApiResult, type Scope, audited, field, notFound, ok } from "./common.js";
import { signingUnconfigured } from "./integrations.js";

export async function webhookEndpoints(deps: ApiDeps, scope: Scope): Promise<ApiResult> {
  const items = await listWebhookEndpoints(deps.pool, scope.organizationId);
  return ok({ items: items.map(webhookEndpointView), endCursor: null, hasNextPage: false } satisfies Page<unknown>);
}

export async function createWebhookEndpoint(deps: ApiDeps, scope: Scope, body: unknown): Promise<ApiResult> {
  const key = usableWebhookSigningKey(deps.webhookSigningKey?.());
  if (!key) return signingUnconfigured();
  const endpoint = await audited(
    deps,
    scope,
    (tx) =>
      storeCreateWebhookEndpoint(tx, {
        organizationId: scope.organizationId,
        repositoryId: field(body, "repositoryId"),
        name: field(body, "name"),
        defaultRiskLevel: field(body, "defaultRiskLevel"),
        enabled: field(body, "enabled"),
        createdByPrincipalId: scope.principalId,
      }),
    (done) => ({ action: "webhook_endpoint.created", target: { type: "webhook_endpoint", id: done.id }, detail: { name: done.name, repositoryId: done.repositoryId } }),
  );
  return {
    status: 201,
    body: {
      endpoint: webhookEndpointView(endpoint),
      secret: deriveWebhookSecret(key, endpoint.id, endpoint.secretVersion),
    },
  };
}

export async function updateWebhookEndpoint(
  deps: ApiDeps,
  scope: Scope,
  endpointId: string,
  body: unknown,
): Promise<ApiResult> {
  const endpoint = await audited(
    deps,
    scope,
    (tx) =>
      storeUpdateWebhookEndpoint(tx, scope.organizationId, endpointId, {
        name: field(body, "name"),
        enabled: field(body, "enabled"),
        defaultRiskLevel: field(body, "defaultRiskLevel"),
      }),
    (done) => (done ? { action: "webhook_endpoint.updated", target: { type: "webhook_endpoint", id: endpointId }, detail: { name: done.name, enabled: done.enabled } } : null),
  );
  return endpoint ? ok({ endpoint: webhookEndpointView(endpoint) }) : notFound("webhook endpoint");
}

export async function deleteWebhookEndpoint(deps: ApiDeps, scope: Scope, endpointId: string): Promise<ApiResult> {
  const removed = await audited(
    deps,
    scope,
    (tx) => storeDeleteWebhookEndpoint(tx, scope.organizationId, endpointId),
    (done) => (done ? { action: "webhook_endpoint.deleted", target: { type: "webhook_endpoint", id: endpointId } } : null),
  );
  return removed ? ok({ deleted: endpointId }) : notFound("webhook endpoint");
}

export async function rotateWebhookEndpoint(deps: ApiDeps, scope: Scope, endpointId: string): Promise<ApiResult> {
  const key = usableWebhookSigningKey(deps.webhookSigningKey?.());
  if (!key) return signingUnconfigured();
  const endpoint = await audited(
    deps,
    scope,
    (tx) => storeRotateWebhookEndpoint(tx, scope.organizationId, endpointId),
    (done) => (done ? { action: "webhook_endpoint.rotated", target: { type: "webhook_endpoint", id: endpointId }, detail: { secretVersion: done.secretVersion } } : null),
  );
  if (!endpoint) return notFound("webhook endpoint");
  return ok({
    endpoint: webhookEndpointView(endpoint),
    secret: deriveWebhookSecret(key, endpoint.id, endpoint.secretVersion),
  });
}

function webhookEndpointView(e: WebhookEndpoint) {
  return {
    id: e.id,
    name: e.name,
    repositoryId: e.repositoryId,
    enabled: e.enabled,
    defaultRiskLevel: e.defaultRiskLevel,
    secretVersion: e.secretVersion,
    path: `/api/intake/webhook/${e.id}`,
    createdAt: e.createdAt,
    rotatedAt: e.rotatedAt,
  };
}

export function routeInput(body: unknown) {
  return {
    scopeKind: field(body, "scopeKind"),
    scopeValue: field(body, "scopeValue"),
    repositoryId: field(body, "repositoryId"),
    triggerLabel: field(body, "triggerLabel"),
    enabled: field(body, "enabled"),
  };
}

export function connectionView(c: IntegrationConnection) {
  return {
    id: c.id,
    provider: c.provider,
    installationId: c.installationId,
    externalTenantId: c.externalTenantId,
    externalTenantName: c.externalTenantName,
    status: c.status,

    createdByPrincipalId: c.createdByPrincipalId,
    createdAt: c.createdAt,
    disconnectedAt: c.disconnectedAt,
  };
}

export function routeView(r: IntegrationRoute) {
  return {
    id: r.id,
    scopeKind: r.scopeKind,
    scopeValue: r.scopeValue,
    repositoryId: r.repositoryId,
    triggerLabel: r.triggerLabel,
    enabled: r.enabled,
    createdAt: r.createdAt,
  };
}
