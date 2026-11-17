

import type { QueryResult } from "pg";
import type { Queryable } from "../../factory/db/transaction.js";

export function selectActiveConnectionByTenant(db: Queryable, provider: string, externalTenantId: string): Promise<QueryResult> {
  return db.query(
    `select * from integration_connection
      where provider = $1 and external_tenant_id = $2 and status = 'active'`,
    [provider, externalTenantId],
  );
}

export function selectConnectionInOrganization(db: Queryable, connectionId: string, organizationId: string): Promise<QueryResult> {
  return db.query("select * from integration_connection where id = $1 and organization_id = $2", [connectionId, organizationId]);
}

export function selectConnectionById(db: Queryable, connectionId: string): Promise<QueryResult> {
  return db.query("select * from integration_connection where id = $1", [connectionId]);
}

export function selectOrganizationConnections(db: Queryable, organizationId: string): Promise<QueryResult> {
  return db.query(
    `select * from integration_connection where organization_id = $1
      order by status asc, provider asc, created_at asc`,
    [organizationId],
  );
}

export function refreshConnectionInstallation(
  db: Queryable,
  connectionId: string,
  installationId: string,
  externalTenantName: string | null,
): Promise<QueryResult> {
  return db.query(
    `update integration_connection
          set installation_id = $2, external_tenant_name = coalesce($3, external_tenant_name)
        where id = $1 returning *`,
    [connectionId, installationId, externalTenantName],
  );
}

export function insertConnection(
  db: Queryable,
  row: {
    organizationId: string;
    provider: string;
    installationId: string;
    externalTenantId: string;
    externalTenantName: string | null;
    createdByPrincipalId: string | null;
  },
): Promise<QueryResult> {
  return db.query(
    `insert into integration_connection
         (organization_id, provider, installation_id, external_tenant_id, external_tenant_name,
          created_by_principal_id)
       values ($1, $2, $3, $4, $5, $6) returning *`,
    [row.organizationId, row.provider, row.installationId, row.externalTenantId, row.externalTenantName, row.createdByPrincipalId],
  );
}

export function selectTenantHolderForReclaim(
  db: Queryable,
  provider: string,
  externalTenantId: string,
  organizationId: string,
  principalId: string | null,
): Promise<QueryResult> {
  return db.query(
    `select (c.organization_id = $3) as own,
            (o.account_id = caller.account_id) as same_account,
            exists (select 1 from account_membership am
                      join access_role ar on ar.id = am.access_role_id
                     where am.principal_id = $4
                       and am.account_id = caller.account_id
                       and 'integrations.manage' = any (ar.permissions)) as account_manages
       from integration_connection c
       join organization o on o.id = c.organization_id
       cross join (select account_id from organization where id = $3) caller
      where c.provider = $1 and c.external_tenant_id = $2
      order by c.created_at desc
      limit 1`,
    [provider, externalTenantId, organizationId, principalId],
  );
}

export function markConnectionDisconnected(db: Queryable, connectionId: string, organizationId: string): Promise<QueryResult> {
  return db.query(
    `update integration_connection
        set status = 'disconnected', disconnected_at = coalesce(disconnected_at, now())
      where id = $1 and organization_id = $2 returning *`,
    [connectionId, organizationId],
  );
}

export function selectRouteForScope(db: Queryable, connectionId: string, scopeKind: unknown, scopeValue: string | null): Promise<QueryResult> {
  return db.query(
    `select * from integration_route
      where connection_id = $1
        and ((scope_kind = $2 and scope_value = $3) or scope_kind = 'default')
      order by case when scope_kind = 'default' then 1 else 0 end
      limit 1`,
    [connectionId, scopeKind, scopeValue],
  );
}

export function selectRoutesOfConnections(db: Queryable, connectionIds: readonly string[]): Promise<QueryResult> {
  return db.query(
    `select * from integration_route where connection_id = any ($1::uuid[])
      order by case when scope_kind = 'default' then 0 else 1 end, scope_kind, scope_value, created_at`,
    [connectionIds],
  );
}

export function insertRoute(
  db: Queryable,
  row: { connectionId: string; scopeKind: string; scopeValue: string | null; repositoryId: string; triggerLabel: string | null; enabled: boolean },
): Promise<QueryResult> {
  return db.query(
    `insert into integration_route (connection_id, scope_kind, scope_value, repository_id, trigger_label, enabled)
       values ($1, $2, $3, $4, $5, $6) returning *`,
    [row.connectionId, row.scopeKind, row.scopeValue, row.repositoryId, row.triggerLabel, row.enabled],
  );
}

export function updateRouteRow(
  db: Queryable,
  routeId: string,
  repositoryId: string,
  triggerLabel: string | null,
  enabled: boolean,
): Promise<QueryResult> {
  return db.query(
    `update integration_route set repository_id = $2, trigger_label = $3, enabled = $4
      where id = $1 returning *`,
    [routeId, repositoryId, triggerLabel, enabled],
  );
}

export function deleteRouteRow(db: Queryable, routeId: string): Promise<QueryResult> {
  return db.query("delete from integration_route where id = $1", [routeId]);
}

export function selectRouteInOrganization(db: Queryable, routeId: string, connectionId: string, organizationId: string): Promise<QueryResult> {
  return db.query(
    `select r.* from integration_route r
       join integration_connection c on c.id = r.connection_id
      where r.id = $1 and r.connection_id = $2 and c.organization_id = $3`,
    [routeId, connectionId, organizationId],
  );
}

export function selectRepositoryGrantRow(db: Queryable, organizationId: string, repositoryId: string): Promise<QueryResult> {
  return db.query("select 1 from repository_grant where organization_id = $1 and repository_id = $2", [organizationId, repositoryId]);
}

type CredentialRow = { connection_id: string; last4: string; updated_at: Date };

export function upsertSentryCredential(
  db: Queryable,
  row: { connectionId: string; organizationId: string; sealed: string; keypairId: string; last4: string; createdByPrincipalId: string | null },
): Promise<QueryResult<CredentialRow>> {
  return db.query<CredentialRow>(
    `insert into sentry_credential (connection_id, organization_id, sealed_value, keypair_id, last4, created_by_principal_id)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (connection_id) do update
       set sealed_value = excluded.sealed_value, keypair_id = excluded.keypair_id, last4 = excluded.last4,
           created_by_principal_id = excluded.created_by_principal_id, updated_at = now()
     where sentry_credential.organization_id = excluded.organization_id
     returning connection_id, last4, updated_at`,
    [row.connectionId, row.organizationId, row.sealed, row.keypairId, row.last4, row.createdByPrincipalId],
  );
}

export function selectSentryCredentialView(db: Queryable, connectionId: string): Promise<QueryResult<CredentialRow>> {
  return db.query<CredentialRow>(
    "select connection_id, last4, updated_at from sentry_credential where connection_id = $1 and sealed_value <> ''",
    [connectionId],
  );
}

export function deleteSentryCredentialRow(db: Queryable, connectionId: string): Promise<QueryResult> {
  return db.query("delete from sentry_credential where connection_id = $1", [connectionId]);
}

export function selectSealedSentryToken(db: Queryable, connectionId: string, organizationId: string): Promise<QueryResult<{ sealed_value: string }>> {
  return db.query<{ sealed_value: string }>(
    "select sealed_value from sentry_credential where connection_id = $1 and organization_id = $2",
    [connectionId, organizationId],
  );
}

export function lockSentryRate(db: Queryable, connectionId: string): Promise<QueryResult> {
  return db.query("select pg_advisory_xact_lock(hashtext($1))", [`windkeel:sentry-rate:${connectionId}`]);
}

export function countRecentCreatedDeliveries(db: Queryable, source: string, prefix: string, deliveryKey: string): Promise<QueryResult<{ n: number }>> {
  return db.query<{ n: number }>(
    `select count(*)::int as n from intake_delivery
      where source = $1 and left(delivery_key, length($2)) = $2 and delivery_key <> $3
        and intent = 'create_task' and engineering_task_id is not null
        and received_at > now() - interval '1 hour'`,
    [source, prefix, deliveryKey],
  );
}

export function selectTaskIdBySourceReference(
  db: Queryable,
  organizationId: string,
  sourceType: string,
  sourceReference: string,
): Promise<QueryResult<{ id: string }>> {
  return db.query<{ id: string }>(
    `select id from engineering_task
              where organization_id = $1 and source_type = $2 and source_reference = $3`,
    [organizationId, sourceType, sourceReference],
  );
}
