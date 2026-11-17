import type { Page } from "@windkeel/api-contract";
import { addRoute, createConnection, deleteRoute, disconnectConnection, getConnection, listConnections, updateRoute } from "@windkeel/factory/integrations";
import { isProvider, PROVIDERS } from "@windkeel/factory/integrations";
import { deleteSentryCredential, getSentryCredential, isTokenShaped, putSentryCredential } from "@windkeel/factory/integrations";
import { type ApiDeps, type ApiError, type ApiResult, type Scope, audited, badRequest, field, jiraWebhookEffect, notFound, ok, stringField } from "./common.js";
import { connectionView, routeInput, routeView } from "./webhook-endpoints.js";

export async function integrations(deps: ApiDeps, scope: Scope): Promise<ApiResult> {
  const items = await listConnections(deps.pool, scope.organizationId);
  return ok({
    items: items.map((c) => ({ ...connectionView(c), routes: c.routes.map(routeView) })),
    endCursor: null,
    hasNextPage: false,
  } satisfies Page<unknown>);
}

export async function createIntegration(deps: ApiDeps, scope: Scope, body: unknown): Promise<ApiResult> {
  const provider = field(body, "provider");
  if (!isProvider(provider)) {
    return badRequest(`provider must be one of ${PROVIDERS.join(", ")}`, "invalid_provider");
  }
  if (provider === "sentry") return createSentryIntegration(deps, scope, body);
  const installationId = stringField(body, "installationId")?.trim();
  if (!installationId) return badRequest("installationId is required", "missing_field");
  if (!deps.integrationTokens) {
    return {
      status: 503,
      body: {
        error: "this deployment has no provider token source, so it cannot connect a workspace",
        code: "integrations_disabled",
      } satisfies ApiError,
    };
  }

  const identity = await deps.integrationTokens.describeInstallation({ provider, installationId });
  if (!identity.tenantId) {
    return {
      status: 422,
      body: {
        error: `Vercel Connect did not say which ${provider} workspace installation ${installationId} is`,
        code: "tenant_unknown",
      } satisfies ApiError,
    };
  }
  const { connection, created } = await audited(
    deps,
    scope,
    (tx) =>
      createConnection(tx, {
        organizationId: scope.organizationId,
        provider,
        installationId,
        externalTenantId: identity.tenantId!,
        externalTenantName: identity.name,
        createdByPrincipalId: scope.principalId,
      }),
    (done) =>
      done.created
        ? {
            action: "integration.connected",
            target: { type: "integration", id: done.connection.id },
            detail: { provider, installationId, tenantId: identity.tenantId },
          }
        : null,
  );
  if (connection.provider === "jira") await jiraWebhookEffect(() => deps.jiraWebhooks?.ensure(connection));
  return { status: created ? 201 : 200, body: { connection: connectionView(connection) } };
}

const SENTRY_INSTALLATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SENTRY_ORG_SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

async function createSentryIntegration(deps: ApiDeps, scope: Scope, body: unknown): Promise<ApiResult> {
  const uuid = (stringField(body, "externalTenantId") ?? stringField(body, "installationId"))?.trim().toLowerCase();
  if (!uuid) return badRequest("externalTenantId (the Sentry installation uuid) is required", "missing_field");
  if (!SENTRY_INSTALLATION.test(uuid)) return badRequest("a Sentry installation id is a uuid", "invalid_field");
  const orgSlug = stringField(body, "orgSlug")?.trim() || stringField(body, "externalTenantName")?.trim() || null;
  if (orgSlug !== null && !SENTRY_ORG_SLUG.test(orgSlug)) return badRequest("orgSlug is a Sentry organization slug", "invalid_field");
  const token = field(body, "token");
  if (token !== undefined && token !== null) {
    if (!isTokenShaped(token)) return badRequest("token is not shaped like a Sentry auth token", "invalid_field");
    if (!deps.secretPublicKey) {
      return {
        status: 503,
        body: {
          error: "WINDKEEL_SECRET_PUBLIC_KEY is not set, so this deployment cannot seal a Sentry token",
          code: "secrets_disabled",
        } satisfies ApiError,
      };
    }
  }
  const { connection, created } = await createConnection(deps.pool, {
    organizationId: scope.organizationId,
    provider: "sentry",
    installationId: uuid,
    externalTenantId: uuid,
    externalTenantName: orgSlug,
    createdByPrincipalId: scope.principalId,
  });
  const credential =
    typeof token === "string" && deps.secretPublicKey
      ? await putSentryCredential(deps.pool, {
          organizationId: scope.organizationId,
          connectionId: connection.id,
          publicKey: deps.secretPublicKey,
          token,
          createdByPrincipalId: scope.principalId,
        })
      : await getSentryCredential(deps.pool, connection.id);
  return {
    status: created ? 201 : 200,
    body: {
      connection: connectionView(connection),
      credential: credential ? { last4: credential.last4, updatedAt: credential.updatedAt } : null,
    },
  };
}

async function syncJiraWebhook(deps: ApiDeps, scope: Scope, integrationId: string): Promise<void> {
  const hooks = deps.jiraWebhooks;
  if (!hooks) return;
  await jiraWebhookEffect(async () => {
    const connection = await getConnection(deps.pool, scope.organizationId, integrationId);
    if (connection?.provider === "jira") await hooks.ensure(connection);
  });
}

export async function deleteIntegration(deps: ApiDeps, scope: Scope, integrationId: string): Promise<ApiResult> {
  const connection = await audited(
    deps,
    scope,
    (tx) => disconnectConnection(tx, scope.organizationId, integrationId),
    (done) => (done ? { action: "integration.disconnected", target: { type: "integration", id: integrationId }, detail: { provider: done.provider } } : null),
  );

  if (connection?.provider === "jira") await jiraWebhookEffect(() => deps.jiraWebhooks?.remove?.(connection));

  if (connection?.provider === "sentry") await deleteSentryCredential(deps.pool, connection.id);
  return connection ? ok({ connection: connectionView(connection) }) : notFound("integration");
}

export async function createIntegrationRoute(
  deps: ApiDeps,
  scope: Scope,
  integrationId: string,
  body: unknown,
): Promise<ApiResult> {
  const route = await audited(
    deps,
    scope,
    (tx) => addRoute(tx, scope.organizationId, integrationId, routeInput(body)),
    (done) => (done ? { action: "integration_route.created", target: { type: "integration_route", id: done.id }, detail: { integrationId } } : null),
  );
  if (route) await syncJiraWebhook(deps, scope, integrationId);
  return route ? { status: 201, body: { route: routeView(route) } } : notFound("integration");
}

export async function updateIntegrationRoute(
  deps: ApiDeps,
  scope: Scope,
  integrationId: string,
  routeId: string,
  body: unknown,
): Promise<ApiResult> {
  const route = await audited(
    deps,
    scope,
    (tx) => updateRoute(tx, scope.organizationId, integrationId, routeId, routeInput(body)),
    (done) => (done ? { action: "integration_route.updated", target: { type: "integration_route", id: routeId }, detail: { integrationId } } : null),
  );
  if (route) await syncJiraWebhook(deps, scope, integrationId);
  return route ? ok({ route: routeView(route) }) : notFound("route");
}

export async function deleteIntegrationRoute(
  deps: ApiDeps,
  scope: Scope,
  integrationId: string,
  routeId: string,
): Promise<ApiResult> {
  const removed = await audited(
    deps,
    scope,
    (tx) => deleteRoute(tx, scope.organizationId, integrationId, routeId),
    (done) => (done ? { action: "integration_route.deleted", target: { type: "integration_route", id: routeId }, detail: { integrationId } } : null),
  );
  if (removed) await syncJiraWebhook(deps, scope, integrationId);
  return removed ? ok({ deleted: routeId }) : notFound("route");
}

export function signingUnconfigured(): ApiResult {
  return {
    status: 503,
    body: {
      error:
        "WINDKEEL_WEBHOOK_SIGNING_KEY is not set on this deployment (or is shorter than 32 bytes), " +
        "so no webhook secret can be issued",
      code: "webhook_signing_unconfigured",
    } satisfies ApiError,
  };
}
