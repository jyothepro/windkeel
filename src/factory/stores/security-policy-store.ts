
import type { Queryable } from "../db/transaction.js";

type Row = Record<string, unknown>;

const SELECT_POLICY = `select p.*, p.ip_allowlist::text[] as ip_allowlist_text from account_security_policy p`;

export async function selectSecurityPolicyRow(db: Queryable, accountId: string): Promise<Row | undefined> {
  const { rows } = await db.query(`${SELECT_POLICY} where p.account_id = $1`, [accountId]);
  return rows[0];
}

export async function selectSecurityPolicyRowForPrincipal(db: Queryable, principalId: string): Promise<Row | undefined> {
  const { rows } = await db.query(
    `${SELECT_POLICY} join principal pr on pr.account_id = p.account_id where pr.id = $1`,
    [principalId],
  );
  return rows[0];
}

export interface SecurityPolicyValues {
  maxTokenTtlDays: number | null;
  requireTokenExpiry: boolean;
  idleSessionMinutes: number | null;
  requireMfa: boolean;
  ipAllowlist: string[] | null;
  auditRetentionDays: number | null;
}

export async function upsertSecurityPolicyRow(
  db: Queryable,
  accountId: string,
  next: SecurityPolicyValues,
  updatedByPrincipalId: string | null,
): Promise<Row> {
  const { rows } = await db.query(
    `insert into account_security_policy
       (account_id, max_token_ttl_days, require_token_expiry, idle_session_minutes, require_mfa,
        ip_allowlist, audit_retention_days, updated_by_principal_id)
     values ($1, $2, $3, $4, $5, $6::cidr[], $7, $8)
     on conflict (account_id) do update set
       max_token_ttl_days = excluded.max_token_ttl_days,
       require_token_expiry = excluded.require_token_expiry,
       idle_session_minutes = excluded.idle_session_minutes,
       require_mfa = excluded.require_mfa,
       ip_allowlist = excluded.ip_allowlist,
       audit_retention_days = excluded.audit_retention_days,
       updated_by_principal_id = excluded.updated_by_principal_id,
       updated_at = now()
     returning *, ip_allowlist::text[] as ip_allowlist_text`,
    [
      accountId,
      next.maxTokenTtlDays,
      next.requireTokenExpiry,
      next.idleSessionMinutes,
      next.requireMfa,
      next.ipAllowlist,
      next.auditRetentionDays,
      updatedByPrincipalId,
    ],
  );
  return rows[0]!;
}

export async function selectSessionLastSeen(db: Queryable, sessionId: string): Promise<Date | null> {
  const { rows } = await db.query("select last_seen_at from session_activity where session_id = $1", [sessionId]);
  return (rows[0]?.["last_seen_at"] as Date | undefined) ?? null;
}

export async function touchSessionActivity(db: Queryable, sessionId: string, principalId: string, now: Date): Promise<void> {
  await db.query(
    `insert into session_activity (session_id, principal_id, last_seen_at) values ($1, $2, $3)
     on conflict (session_id) do update set last_seen_at = greatest(session_activity.last_seen_at, excluded.last_seen_at)
      where session_activity.principal_id = excluded.principal_id`,
    [sessionId, principalId, now],
  );
}
