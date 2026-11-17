

import type { Pool, PoolClient, QueryResult } from "pg";
import type { Criterion } from "@windkeel/verification/evidence/format.js";
import type { RiskLevel } from "../../factory/rails.js";
import type { Queryable } from "../../factory/db/transaction.js";

type QueryOnly = { query: Pool["query"] } | Pick<PoolClient, "query">;

export function claimIntakeDelivery(
  db: Queryable,
  row: {
    source: string;
    deliveryKey: string;
    organizationId: string | null;
    event: string | null;
    action: string | null;
    intent: string;
    reason: string | null;
  },
): Promise<QueryResult> {
  return db.query(
    `insert into intake_delivery
         (source, delivery_key, organization_id, event, action, intent, reason)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (source, delivery_key) do nothing
       returning delivery_key`,
    [row.source, row.deliveryKey, row.organizationId, row.event, row.action, row.intent, row.reason],
  );
}

export function updateIntakeDelivery(
  db: Queryable,
  source: string,
  deliveryKey: string,
  changes: { intent?: string; engineeringTaskId?: string | null; organizationId?: string | null; reason?: string | null },
): Promise<QueryResult> | null {
  const sets: string[] = [];
  const values: unknown[] = [source, deliveryKey];
  const bind = (column: string, value: unknown): void => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (changes.intent !== undefined) bind("intent", changes.intent);
  if (changes.engineeringTaskId !== undefined) bind("engineering_task_id", changes.engineeringTaskId);
  if (changes.organizationId !== undefined) {
    bind("organization_id", changes.organizationId);
  } else if (changes.engineeringTaskId) {

    values.push(changes.engineeringTaskId);
    sets.push(`organization_id = (select organization_id from engineering_task where id = $${values.length})`);
  }
  if (changes.reason !== undefined) bind("reason", changes.reason);
  if (sets.length === 0) return null;
  return db.query(`update intake_delivery set ${sets.join(", ")} where source = $1 and delivery_key = $2`, values);
}

export function deleteIntakeDelivery(db: QueryOnly, source: string, deliveryKey: string): Promise<QueryResult> {
  return (db as Pool).query("delete from intake_delivery where source = $1 and delivery_key = $2", [source, deliveryKey]);
}

export function insertIdempotencyClaim(
  db: Queryable,
  source: string,
  deliveryKey: string,
  organizationId: string,
  requestHash: string,
): Promise<QueryResult> {
  return db.query(
    `insert into intake_delivery (source, delivery_key, organization_id, event, intent, request_hash)
     values ($1, $2, $3, 'create_task', 'create_task', $4)
     on conflict (source, delivery_key) do nothing
     returning delivery_key`,
    [source, deliveryKey, organizationId, requestHash],
  );
}

export function selectIdempotencyRecord<R extends { request_hash: string | null; engineering_task_id: string | null; response: unknown }>(
  db: Queryable,
  source: string,
  deliveryKey: string,
): Promise<QueryResult<R>> {
  return db.query<R>(`select request_hash, engineering_task_id, response from intake_delivery where source = $1 and delivery_key = $2`, [
    source,
    deliveryKey,
  ]);
}

export function setIntakeDeliveryResponse(db: QueryOnly, source: string, deliveryKey: string, responseJson: string): Promise<QueryResult> {
  return (db as Pool).query(`update intake_delivery set response = $3 where source = $1 and delivery_key = $2`, [source, deliveryKey, responseJson]);
}

export function selectTaskBySourceReference(
  db: Queryable,
  organizationId: string | undefined,
  sourceType: string,
  sourceReference: string,
): Promise<QueryResult<{ id: string; acceptance_criteria: Criterion[] }>> {
  return db.query<{ id: string; acceptance_criteria: Criterion[] }>(
    `select id, acceptance_criteria from engineering_task
      where organization_id = $1 and source_type = $2 and source_reference = $3`,
    [organizationId, sourceType, sourceReference],
  );
}

export function selectTaskRiskBySourceReference(
  db: Queryable,
  organizationId: string,
  sourceType: string,
  sourceReference: string,
): Promise<QueryResult<{ id: string; risk_level: RiskLevel }>> {
  return db.query<{ id: string; risk_level: RiskLevel }>(
    `select id, risk_level from engineering_task
              where organization_id = $1 and source_type = $2 and source_reference = $3`,
    [organizationId, sourceType, sourceReference],
  );
}

export function setTaskSourceContext(db: Queryable, taskId: string, sourceContextJson: string): Promise<QueryResult> {
  return db.query(`update engineering_task set source_context = $2::jsonb where id = $1`, [taskId, sourceContextJson]);
}

export function selectLatestVerdict(db: Queryable, engineeringRunId: string): Promise<QueryResult> {
  return db.query(
    `select v.verdict, v.risk_summary,
              jsonb_array_length(coalesce(t.acceptance_criteria, '[]'::jsonb)) as criteria_count
         from verification_run v
         join engineering_run r on r.id = v.engineering_run_id
         join engineering_task t on t.id = r.task_id
        where v.engineering_run_id = $1 and v.completed_at is not null and v.verdict is not null
        order by v.completed_at desc, v.id desc
        limit 1`,
    [engineeringRunId],
  );
}

export function selectGrantedRepositoryByName(
  db: Queryable,
  organizationId: string,
  owner: string,
  name: string,
): Promise<QueryResult<{ id: string }>> {
  return db.query<{ id: string }>(
    `select r.id from repository r
       join repository_grant g on g.repository_id = r.id and g.organization_id = $1
      where lower(r.owner) = lower($2) and lower(r.name) = lower($3)
      limit 1`,
    [organizationId, owner, name],
  );
}

export function selectTaskSourceContext<C>(db: Queryable, taskId: string): Promise<QueryResult<{ source_context: C | null }>> {
  return db.query<{ source_context: C | null }>("select source_context from engineering_task where id = $1", [taskId]);
}

export function markAnnounceClaimFailed(db: Queryable, taskId: string, reason: string): Promise<QueryResult> {
  return db.query(
    `update engineering_task
            set source_context = jsonb_set(source_context, '{announce,failed}', to_jsonb($2::text))
          where id = $1`,
    [taskId, reason],
  );
}

export function claimAnnounce<C>(db: Queryable, taskId: string, runId: string, staleMs: number): Promise<QueryResult<{ source_context: C }>> {
  return db.query<{ source_context: C }>(
    `update engineering_task
          set source_context = coalesce(source_context, '{}'::jsonb)
                || jsonb_build_object('announce', jsonb_build_object('runId', $2::text, 'claimedAt', now()))
        where id = $1
          and (source_context->'announce' is null
               or (source_context->'announce'->>'ts' is null
                   and source_context->'announce'->>'failed' is null
                   and (source_context->'announce'->>'claimedAt')::timestamptz
                         < now() - make_interval(secs => $3::double precision / 1000)))
        returning source_context`,
    [taskId, runId, staleMs],
  );
}

export function releaseAnnounceClaim(db: Queryable, taskId: string): Promise<QueryResult> {
  return db.query("update engineering_task set source_context = source_context - 'announce' where id = $1", [taskId]);
}

export function recordAnnounceTs(db: Queryable, taskId: string, ts: string): Promise<QueryResult> {
  return db.query(
    `update engineering_task
              set source_context = source_context
                    || jsonb_build_object('announce', (source_context->'announce') || jsonb_build_object('ts', $2::text))
                    || case when source_context->>'threadTs' is null
                            then jsonb_build_object('threadTs', $2::text) else '{}'::jsonb end
            where id = $1`,
    [taskId, ts],
  );
}

export function claimNotifiedTransition(db: Queryable, taskId: string, transitionId: string): Promise<QueryResult> {
  return db.query(
    `update engineering_task
        set source_context = jsonb_set(coalesce(source_context, '{}'::jsonb), '{notified}',
              coalesce(source_context->'notified', '[]'::jsonb) || to_jsonb($2::text))
      where id = $1 and not (coalesce(source_context->'notified', '[]'::jsonb) ? $2)`,
    [taskId, transitionId],
  );
}

export function releaseNotifiedTransition(db: Queryable, taskId: string, transitionId: string): Promise<QueryResult> {
  return db.query(
    `update engineering_task
        set source_context = jsonb_set(source_context, '{notified}', (source_context->'notified') - $2::text)
      where id = $1 and source_context->'notified' is not null`,
    [taskId, transitionId],
  );
}

export function setDeliveryFeedback(db: Queryable, source: string, deliveryKey: string, feedbackJson: string): Promise<QueryResult> {
  return db.query(
    `update intake_delivery set response = jsonb_build_object('slackFeedback', $3::jsonb)
      where source = $1 and delivery_key = $2`,
    [source, deliveryKey, feedbackJson],
  );
}

export function moveDeliveryFeedback<F>(
  db: Queryable,
  source: string,
  deliveryKey: string,
  fieldsJson: string,
  from: string,
): Promise<QueryResult<{ feedback: F }>> {
  return db.query<{ feedback: F }>(
    `update intake_delivery
        set response = jsonb_set(response, '{slackFeedback}', (response->'slackFeedback') || $3::jsonb)
      where source = $1 and delivery_key = $2 and response->'slackFeedback'->>'state' = $4
      returning response->'slackFeedback' as feedback`,
    [source, deliveryKey, fieldsJson, from],
  );
}

export function insertWebhookEndpoint(
  db: Queryable,
  row: {
    organizationId: string;
    repositoryId: string;
    name: string;
    defaultRiskLevel: string;
    enabled: boolean;
    createdByPrincipalId: string | null;
  },
): Promise<QueryResult> {
  return db.query(
    `insert into webhook_endpoint
       (organization_id, repository_id, name, default_risk_level, enabled, created_by_principal_id)
     values ($1, $2, $3, $4, $5, $6)
     returning *`,
    [row.organizationId, row.repositoryId, row.name, row.defaultRiskLevel, row.enabled, row.createdByPrincipalId],
  );
}

export function selectWebhookEndpoints(db: Queryable, organizationId: string): Promise<QueryResult> {
  return db.query("select * from webhook_endpoint where organization_id = $1 order by created_at, id", [organizationId]);
}

export function selectWebhookEndpointById(db: QueryOnly, endpointId: string): Promise<QueryResult> {
  return (db as Pool).query("select * from webhook_endpoint where id = $1", [endpointId]);
}

export function updateWebhookEndpointColumns(
  db: Queryable,
  endpointId: string,
  organizationId: string,
  changes: { name?: string; enabled?: boolean; defaultRiskLevel?: string },
): Promise<QueryResult> {
  const sets: string[] = [];
  const values: unknown[] = [endpointId, organizationId];
  const bind = (column: string, value: unknown): void => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (changes.name !== undefined) bind("name", changes.name);
  if (changes.enabled !== undefined) bind("enabled", changes.enabled);
  if (changes.defaultRiskLevel !== undefined) bind("default_risk_level", changes.defaultRiskLevel);
  return db.query(`update webhook_endpoint set ${sets.join(", ")} where id = $1 and organization_id = $2 returning *`, values);
}

export function bumpWebhookEndpointSecret(db: Queryable, endpointId: string, organizationId: string): Promise<QueryResult> {
  return db.query(
    `update webhook_endpoint set secret_version = secret_version + 1, rotated_at = now()
      where id = $1 and organization_id = $2 returning *`,
    [endpointId, organizationId],
  );
}

export function deleteWebhookEndpointRow(db: Queryable, endpointId: string, organizationId: string): Promise<QueryResult> {
  return db.query("delete from webhook_endpoint where id = $1 and organization_id = $2", [endpointId, organizationId]);
}
