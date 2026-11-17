

import type { QueryResult } from "pg";
import type { Queryable } from "../../factory/db/transaction.js";

export interface JiraWebhookWrite {
  connectionId: string;
  cloudId: string;
  siteUrl: string | null;
  webhookIds: number[];
  retiredWebhookIds: number[];
  jql: string;
  expiresAt: Date;
  lastRefreshedAt: Date | null;
  lastError: string | null;
}

export function selectSchema(db: Queryable): Promise<QueryResult<{ schema: string }>> {
  return db.query<{ schema: string }>("select current_schema() as schema");
}

export function setLocalLockTimeout(db: Queryable, timeout: string): Promise<QueryResult> {
  return db.query("select set_config('lock_timeout', $1, true)", [timeout]);
}

export function clearLocalLockTimeout(db: Queryable): Promise<QueryResult> {
  return db.query("select set_config('lock_timeout', '0', true)");
}

export function lockConnectionXact(db: Queryable, namespace: number, key: number): Promise<QueryResult> {
  return db.query("select pg_advisory_xact_lock($1, $2)", [namespace, key]);
}

export function markConnectionDirty(db: Queryable, connectionId: string): Promise<QueryResult> {
  return db.query(
    `insert into jira_webhook_dirty (connection_id) values ($1)
     on conflict (connection_id) do update
       set generation = jira_webhook_dirty.generation + 1, marked_at = now()`,
    [connectionId],
  );
}

export function selectDirtyGeneration(db: Queryable, connectionId: string): Promise<QueryResult<{ generation: string }>> {
  return db.query<{ generation: string }>("select generation from jira_webhook_dirty where connection_id = $1", [connectionId]);
}

export function clearDirtyThrough(db: Queryable, connectionId: string, covered: number): Promise<QueryResult> {
  return db.query("delete from jira_webhook_dirty where connection_id = $1 and generation <= $2", [connectionId, covered]);
}

export function deleteDirtyMark(db: Queryable, connectionId: string): Promise<QueryResult> {
  return db.query("delete from jira_webhook_dirty where connection_id = $1", [connectionId]);
}

export function selectJiraWebhookRow(db: Queryable, connectionId: string): Promise<QueryResult> {
  return db.query("select * from jira_webhook where connection_id = $1", [connectionId]);
}

export function selectJiraSiteUrl(db: Queryable, connectionId: string): Promise<QueryResult<{ site_url: string | null }>> {
  return db.query<{ site_url: string | null }>("select site_url from jira_webhook where connection_id = $1", [connectionId]);
}

export function selectConnectionStatus(db: Queryable, connectionId: string): Promise<QueryResult<{ status: string }>> {
  return db.query<{ status: string }>("select status from integration_connection where id = $1", [connectionId]);
}

export function selectEnabledRouteScopes(
  db: Queryable,
  connectionId: string,
): Promise<QueryResult<{ scope_kind: string; scope_value: string | null }>> {
  return db.query<{ scope_kind: string; scope_value: string | null }>(
    "select scope_kind, scope_value from integration_route where connection_id = $1 and enabled",
    [connectionId],
  );
}

export function deleteJiraWebhookRow(db: Queryable, connectionId: string): Promise<QueryResult> {
  return db.query("delete from jira_webhook where connection_id = $1", [connectionId]);
}

export function recordJiraRefresh(
  db: Queryable,
  connectionId: string,
  expiresAt: Date,
  refreshedAt: Date,
  lastError: string | null,
  retired: number[],
): Promise<QueryResult> {
  return db.query(
    `update jira_webhook set expires_at = $2, last_refreshed_at = $3, last_error = $4,
                    retired_webhook_ids = $5::bigint[]
              where connection_id = $1`,
    [connectionId, expiresAt, refreshedAt, lastError, retired],
  );
}

export function recordJiraUnchanged(
  db: Queryable,
  connectionId: string,
  expiresAt: Date,
  lastError: string | null,
  retired: number[],
): Promise<QueryResult> {
  return db.query(
    `update jira_webhook set expires_at = $2, last_error = $3, retired_webhook_ids = $4::bigint[]
            where connection_id = $1`,
    [connectionId, expiresAt, lastError, retired],
  );
}

export function setJiraWebhookError(db: Queryable, connectionId: string, lastError: string): Promise<QueryResult> {
  return db.query("update jira_webhook set last_error = $2 where connection_id = $1", [connectionId, lastError]);
}

export function dropRetiredWebhookIds(db: Queryable, connectionId: string, ids: number[]): Promise<QueryResult> {
  return db.query(
    `update jira_webhook
        set retired_webhook_ids = array(select unnest(retired_webhook_ids) except select unnest($2::bigint[]))
      where connection_id = $1`,
    [connectionId, ids],
  );
}

export function upsertJiraWebhook(db: Queryable, row: JiraWebhookWrite): Promise<QueryResult> {
  return db.query(
    `insert into jira_webhook
       (connection_id, cloud_id, site_url, webhook_ids, retired_webhook_ids, jql, expires_at, last_refreshed_at, last_error)
     values ($1, $2, $3, $4::bigint[], $5::bigint[], $6, $7, $8, $9)
     on conflict (connection_id) do update set
       cloud_id = excluded.cloud_id,
       site_url = coalesce(excluded.site_url, jira_webhook.site_url),
       webhook_ids = excluded.webhook_ids,
       retired_webhook_ids = excluded.retired_webhook_ids,
       jql = excluded.jql,
       expires_at = excluded.expires_at,
       last_refreshed_at = coalesce(excluded.last_refreshed_at, jira_webhook.last_refreshed_at),
       last_error = excluded.last_error`,
    [
      row.connectionId,
      row.cloudId,
      row.siteUrl,
      row.webhookIds,
      row.retiredWebhookIds,
      row.jql,
      row.expiresAt,
      row.lastRefreshedAt,
      row.lastError,
    ],
  );
}

export function selectGoneJiraConnections(db: Queryable, limit: number): Promise<QueryResult> {
  return db.query(
    `select c.* from integration_connection c
       join jira_webhook w on w.connection_id = c.id
      where c.provider = 'jira' and c.status <> 'active'
      order by c.disconnected_at asc nulls first, c.created_at
      limit $1`,
    [limit],
  );
}

export function selectActiveJiraConnections(db: Queryable): Promise<QueryResult> {
  return db.query(
    `select c.* from integration_connection c
       left join jira_webhook w on w.connection_id = c.id
       left join jira_webhook_dirty d on d.connection_id = c.id
      where c.provider = 'jira' and c.status = 'active'
      order by (d.connection_id is null), w.expires_at asc nulls first, c.created_at`,
  );
}

export function selectJiraSitesByWebhookIds(
  db: Queryable,
  ids: number[],
): Promise<QueryResult<{ cloud_id: string; site_url: string | null }>> {
  return db.query<{ cloud_id: string; site_url: string | null }>("select cloud_id, site_url from jira_webhook where webhook_ids && $1::bigint[]", [
    ids,
  ]);
}
