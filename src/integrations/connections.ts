

import type { Pool, PoolClient } from "pg";
import {
  deleteRouteRow,
  insertConnection,
  insertRoute,
  markConnectionDisconnected,
  refreshConnectionInstallation,
  selectActiveConnectionByTenant,
  selectConnectionInOrganization,
  selectOrganizationConnections,
  selectRepositoryGrantRow,
  selectRouteForScope,
  selectRouteInOrganization,
  selectRoutesOfConnections,
  selectTenantHolderForReclaim,
  updateRouteRow,
} from "./stores/connections-store.js";
import {
  RouteError,
  TenantClaimedError,
  type IntegrationProvider,
} from "./errors.js";

type Queryable = Pool | PoolClient;

export type ScopeKind = "default" | "slack_channel" | "linear_team" | "jira_project" | "sentry_project";

export const PROVIDER_SCOPE: Readonly<Record<IntegrationProvider, Exclude<ScopeKind, "default">>> = {
  slack: "slack_channel",
  linear: "linear_team",
  jira: "jira_project",
  sentry: "sentry_project",
};

export interface IntegrationConnection {
  id: string;
  organizationId: string;
  provider: IntegrationProvider;
  installationId: string;
  externalTenantId: string;
  externalTenantName: string | null;
  status: "active" | "disconnected";
  createdByPrincipalId: string | null;
  createdAt: Date;
  disconnectedAt: Date | null;
}

export interface IntegrationRoute {
  id: string;
  connectionId: string;
  scopeKind: ScopeKind;
  scopeValue: string | null;
  repositoryId: string;
  triggerLabel: string;
  enabled: boolean;
  createdAt: Date;
}

export function rowToConnection(row: Record<string, unknown>): IntegrationConnection {
  return {
    id: row["id"] as string,
    organizationId: row["organization_id"] as string,
    provider: row["provider"] as IntegrationProvider,
    installationId: row["installation_id"] as string,
    externalTenantId: row["external_tenant_id"] as string,
    externalTenantName: (row["external_tenant_name"] as string | null) ?? null,
    status: row["status"] as IntegrationConnection["status"],
    createdByPrincipalId: (row["created_by_principal_id"] as string | null) ?? null,
    createdAt: row["created_at"] as Date,
    disconnectedAt: (row["disconnected_at"] as Date | null) ?? null,
  };
}

function rowToRoute(row: Record<string, unknown>): IntegrationRoute {
  return {
    id: row["id"] as string,
    connectionId: row["connection_id"] as string,
    scopeKind: row["scope_kind"] as ScopeKind,
    scopeValue: (row["scope_value"] as string | null) ?? null,
    repositoryId: row["repository_id"] as string,
    triggerLabel: row["trigger_label"] as string,
    enabled: row["enabled"] as boolean,
    createdAt: row["created_at"] as Date,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveConnection(
  db: Queryable,
  provider: IntegrationProvider,
  externalTenantId: string,
): Promise<IntegrationConnection | null> {
  const { rows } = await selectActiveConnectionByTenant(db, provider, externalTenantId);
  return rows[0] ? rowToConnection(rows[0]) : null;
}

export async function resolveRoute(
  db: Queryable,
  connectionId: string,
  scope: { scopeKind: ScopeKind; scopeValue?: string | null },
): Promise<IntegrationRoute | null> {
  if (!UUID.test(connectionId)) return null;
  const specific = scope.scopeKind !== "default" && scope.scopeValue ? scope.scopeValue : null;
  const { rows } = await selectRouteForScope(db, connectionId, scope.scopeKind, specific);
  return rows[0] ? rowToRoute(rows[0]) : null;
}

export async function getConnection(
  db: Queryable,
  organizationId: string,
  connectionId: string,
): Promise<IntegrationConnection | null> {
  if (!UUID.test(connectionId)) return null;
  const { rows } = await selectConnectionInOrganization(db, connectionId, organizationId);
  return rows[0] ? rowToConnection(rows[0]) : null;
}

export async function listConnections(
  db: Queryable,
  organizationId: string,
): Promise<Array<IntegrationConnection & { routes: IntegrationRoute[] }>> {
  const { rows } = await selectOrganizationConnections(db, organizationId);
  const connections = rows.map(rowToConnection);
  if (connections.length === 0) return [];
  const { rows: routeRows } = await selectRoutesOfConnections(db, connections.map((c) => c.id));
  const routes = routeRows.map(rowToRoute);
  return connections.map((c) => ({ ...c, routes: routes.filter((r) => r.connectionId === c.id) }));
}

export async function createConnection(
  db: Queryable,
  input: {
    organizationId: string;
    provider: IntegrationProvider;
    installationId: string;
    externalTenantId: string;
    externalTenantName: string | null;
    createdByPrincipalId: string | null;
  },
): Promise<{ connection: IntegrationConnection; created: boolean }> {
  const existing = await resolveConnection(db, input.provider, input.externalTenantId);
  if (existing) {
    if (existing.organizationId !== input.organizationId) {
      throw new TenantClaimedError(input.provider, input.externalTenantId);
    }
    const { rows } = await refreshConnectionInstallation(db, existing.id, input.installationId, input.externalTenantName);
    return { connection: rowToConnection(rows[0]), created: false };
  }
  await assertMayReclaim(db, input);
  try {
    const { rows } = await insertConnection(db, {
      organizationId: input.organizationId,
      provider: input.provider,
      installationId: input.installationId,
      externalTenantId: input.externalTenantId,
      externalTenantName: input.externalTenantName,
      createdByPrincipalId: input.createdByPrincipalId,
    });
    return { connection: rowToConnection(rows[0]), created: true };
  } catch (err) {
    if (isUniqueViolation(err)) throw new TenantClaimedError(input.provider, input.externalTenantId);
    throw err;
  }
}

async function assertMayReclaim(
  db: Queryable,
  input: {
    organizationId: string;
    provider: IntegrationProvider;
    externalTenantId: string;
    createdByPrincipalId: string | null;
  },
): Promise<void> {
  const { rows } = await selectTenantHolderForReclaim(db, input.provider, input.externalTenantId, input.organizationId, input.createdByPrincipalId);

  const prior = rows[0];
  if (!prior || prior["own"]) return;
  if (!prior["same_account"]) {
    throw new TenantClaimedError(
      input.provider,
      input.externalTenantId,
      `that ${input.provider} workspace was connected to an organization in another account; the operator must release it first`,
    );
  }
  if (!prior["account_manages"]) {
    throw new TenantClaimedError(
      input.provider,
      input.externalTenantId,
      `that ${input.provider} workspace was connected to another organization; reconnecting it here needs integrations.manage through an account role`,
    );
  }
}

export async function disconnectConnection(
  db: Queryable,
  organizationId: string,
  connectionId: string,
): Promise<IntegrationConnection | null> {
  if (!UUID.test(connectionId)) return null;
  const { rows } = await markConnectionDisconnected(db, connectionId, organizationId);
  return rows[0] ? rowToConnection(rows[0]) : null;
}

export interface RouteInput {
  scopeKind?: unknown;
  scopeValue?: unknown;
  repositoryId?: unknown;
  triggerLabel?: unknown;
  enabled?: unknown;
}

export async function addRoute(
  db: Queryable,
  organizationId: string,
  connectionId: string,
  input: RouteInput,
): Promise<IntegrationRoute | null> {
  const connection = await getConnection(db, organizationId, connectionId);
  if (!connection) return null;
  if (connection.status !== "active") {
    throw new RouteError("that connection is disconnected", "connection_disconnected", 409);
  }

  const scopeKind = input.scopeKind === undefined ? "default" : input.scopeKind;
  const allowed: ScopeKind[] = ["default", PROVIDER_SCOPE[connection.provider]];
  if (typeof scopeKind !== "string" || !(allowed as string[]).includes(scopeKind)) {
    throw new RouteError(
      `scopeKind for a ${connection.provider} connection is one of ${allowed.join(", ")}`,
      "invalid_route",
      400,
    );
  }
  let scopeValue: string | null = null;
  if (scopeKind === "default") {
    if (input.scopeValue !== undefined && input.scopeValue !== null && input.scopeValue !== "") {
      throw new RouteError("a default route has no scopeValue", "invalid_route", 400);
    }
  } else {
    if (typeof input.scopeValue !== "string" || input.scopeValue.trim() === "") {
      throw new RouteError(`a ${scopeKind} route needs a scopeValue`, "invalid_route", 400);
    }
    scopeValue = input.scopeValue.trim();
  }
  const repositoryId = await grantedRepositoryId(db, organizationId, input.repositoryId);
  const triggerLabel = labelFrom(input.triggerLabel) ?? "windkeel";
  const enabled = input.enabled === undefined ? true : enabledFrom(input.enabled);

  try {
    const { rows } = await insertRoute(db, { connectionId, scopeKind, scopeValue, repositoryId, triggerLabel, enabled });
    return rowToRoute(rows[0]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new RouteError("that connection already has a route for this scope", "route_exists", 409);
    }
    throw err;
  }
}

export async function updateRoute(
  db: Queryable,
  organizationId: string,
  connectionId: string,
  routeId: string,
  input: RouteInput,
): Promise<IntegrationRoute | null> {
  const route = await routeInOrganization(db, organizationId, connectionId, routeId);
  if (!route) return null;
  if (input.scopeKind !== undefined || input.scopeValue !== undefined) {
    throw new RouteError("a route's scope cannot change; remove it and add another", "invalid_route", 400);
  }
  const repositoryId =
    input.repositoryId === undefined ? route.repositoryId : await grantedRepositoryId(db, organizationId, input.repositoryId);
  const triggerLabel =
    input.triggerLabel === undefined ? route.triggerLabel : (labelFrom(input.triggerLabel) ?? invalidLabel());
  const enabled = input.enabled === undefined ? route.enabled : enabledFrom(input.enabled);
  const { rows } = await updateRouteRow(db, route.id, repositoryId, triggerLabel, enabled);
  return rowToRoute(rows[0]);
}

export async function deleteRoute(
  db: Queryable,
  organizationId: string,
  connectionId: string,
  routeId: string,
): Promise<boolean> {
  const route = await routeInOrganization(db, organizationId, connectionId, routeId);
  if (!route) return false;
  const { rowCount } = await deleteRouteRow(db, route.id);
  return (rowCount ?? 0) > 0;
}

async function routeInOrganization(
  db: Queryable,
  organizationId: string,
  connectionId: string,
  routeId: string,
): Promise<IntegrationRoute | null> {
  if (!UUID.test(connectionId) || !UUID.test(routeId)) return null;
  const { rows } = await selectRouteInOrganization(db, routeId, connectionId, organizationId);
  return rows[0] ? rowToRoute(rows[0]) : null;
}

async function grantedRepositoryId(db: Queryable, organizationId: string, repositoryId: unknown): Promise<string> {
  if (typeof repositoryId !== "string" || !UUID.test(repositoryId)) {
    throw new RouteError("repositoryId is required", "invalid_route", 400);
  }
  const { rows } = await selectRepositoryGrantRow(db, organizationId, repositoryId);
  if (rows.length === 0) {
    throw new RouteError(
      "that repository is not granted to this organization; grant it first",
      "repository_not_granted",
      422,
    );
  }
  return repositoryId;
}

function labelFrom(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "" || value.length > 100) invalidLabel();
  return (value).trim();
}

function invalidLabel(): never {
  throw new RouteError("triggerLabel must be a non-empty string of at most 100 characters", "invalid_route", 400);
}

function enabledFrom(value: unknown): boolean {
  if (typeof value !== "boolean") throw new RouteError("enabled must be true or false", "invalid_route", 400);
  return value;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}
