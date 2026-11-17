

import type { QueryResult } from "pg";
import type { Queryable } from "../../factory/db/transaction.js";

export function selectBackendPid(db: Queryable): Promise<QueryResult<{ pid: number }>> {
  return db.query<{ pid: number }>("select pg_backend_pid() as pid");
}

export function tryAdvisoryLock(db: Queryable, key: number): Promise<QueryResult<{ locked: boolean }>> {
  return db.query<{ locked: boolean }>("select pg_try_advisory_lock($1) as locked", [key]);
}

export function advisoryUnlock(db: Queryable, key: number): Promise<QueryResult<{ unlocked: boolean }>> {
  return db.query<{ unlocked: boolean }>("select pg_advisory_unlock($1) as unlocked", [key]);
}

export function selectRepositorySecrets(db: Queryable): Promise<QueryResult<{ key: string; sealed_value: string; repository_id: string }>> {
  return db.query<{ key: string; sealed_value: string; repository_id: string }>(
    `select key, sealed_value, repository_id from repository_secret order by repository_id, key`,
  );
}

export function selectModelCredentialSummary(
  db: Queryable,
  staleHours: number,
): Promise<QueryResult<{ status: string; total: number; stale: number; invalid_labels: string[] | null }>> {
  return db.query(
    `select status, count(*)::int as total,
                count(*) filter (where status = 'unverified' and revoked_at is null
                                   and updated_at < now() - interval '${staleHours} hour')::int as stale,
                array_agg(label || ' (organization ' || left(organization_id::text, 8) || ')' order by label)
                  filter (where status = 'invalid') as invalid_labels
           from model_credential
          group by status
          order by status`,
  );
}

export function selectRecentModelSnapshots(db: Queryable): Promise<QueryResult<{ total: number; customer: number }>> {
  return db.query<{ total: number; customer: number }>(
    `select count(*)::int as total,
              count(*) filter (where model_config->'maker'->>'keySource' = 'customer'
                                  or model_config->'checker' @> '[{"keySource":"customer"}]')::int as customer
         from engineering_run
        where model_config is not null and created_at > now() - interval '7 days'`,
  );
}

export function selectSecurityControlCounts(db: Queryable): Promise<QueryResult> {
  return db.query(
    `/* security_controls */ select
           (select count(*)::int from api_token
             where revoked_at is null and expires_at is null) as tokens_without_expiry,
           (select count(*)::int from audit_event e join principal p on p.id = e.actor_principal_id
             where p.is_bootstrap and e.occurred_at > now() - interval '30 days') as bootstrap_events,
           (select count(*)::int from audit_sink_cursor where failures > 0) as sink_failing,
           (select count(*)::int from verification_run
             where completed_at > now() - interval '30 days' and verdict is not null) as verified_recent,
           (select count(*)::int from verification_run
             where completed_at > now() - interval '30 days' and risk_summary->>'signed' = 'false') as unsigned_recent`,
  );
}
