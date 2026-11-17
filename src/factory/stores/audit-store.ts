
import type { Queryable } from "../db/transaction.js";

type Row = Record<string, unknown>;

const SELECT_EVENT = `select e.*, host(e.ip) as ip_text from audit_event e`;

export async function selectOrganizationAccountId(db: Queryable, organizationId: string): Promise<string | null> {
  const { rows } = await db.query("select account_id from organization where id = $1", [organizationId]);
  return (rows[0]?.["account_id"] as string | undefined) ?? null;
}

export async function lockAuditAccount(db: Queryable, accountId: string): Promise<void> {
  await db.query("select pg_advisory_xact_lock(hashtext('orqon.audit_event'), hashtext($1::text))", [accountId]);
}

export async function selectAuditChainHead(db: Queryable, accountId: string): Promise<Row | undefined> {
  const { rows } = await db.query(
    "select seq, hash, occurred_at from audit_event where account_id = $1 order by seq desc limit 1",
    [accountId],
  );
  return rows[0];
}

export async function selectCanonicalInet(db: Queryable, candidate: string): Promise<string | null> {
  const { rows } = await db.query("select host($1::inet) as ip", [candidate]);
  return (rows[0]?.["ip"] as string | undefined) ?? null;
}

export interface AuditEventInsert {
  id: string;
  accountId: string;
  seq: number;
  organizationId: string | null;
  actorPrincipalId: string | null;
  actorText: string;
  actorKind: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;

  detail: string;
  prevHash: Buffer | null;
  hash: Buffer;
  occurredAt: string;
}

export async function insertAuditEventRow(db: Queryable, v: AuditEventInsert): Promise<void> {
  await db.query(
    `insert into audit_event
       (id, account_id, seq, organization_id, actor_principal_id, actor_text, actor_kind, action,
        target_type, target_id, ip, user_agent, request_id, detail, prev_hash, hash, occurred_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::inet, $12, $13, $14, $15, $16, $17)`,
    [
      v.id,
      v.accountId,
      v.seq,
      v.organizationId,
      v.actorPrincipalId,
      v.actorText,
      v.actorKind,
      v.action,
      v.targetType,
      v.targetId,
      v.ip,
      v.userAgent,
      v.requestId,
      v.detail,
      v.prevHash,
      v.hash,
      v.occurredAt,
    ],
  );
}

export async function selectRunOrganizationForAudit(db: Queryable, engineeringRunId: string): Promise<string | null> {
  const { rows } = await db.query(
    `select t.organization_id from engineering_run r join engineering_task t on t.id = r.task_id where r.id = $1`,
    [engineeringRunId],
  );
  return (rows[0]?.["organization_id"] as string | null | undefined) ?? null;
}

export async function selectAuditEventRows(
  db: Queryable,
  where: readonly string[],
  params: readonly unknown[],
  order: "asc" | "desc",
  limit: number,
): Promise<Row[]> {
  const bound = [...params, limit];
  const { rows } = await db.query(
    `${SELECT_EVENT} where ${where.join(" and ")} order by e.seq ${order} limit $${bound.length}`,
    bound,
  );
  return rows;
}

export async function hasAuditAnchor(db: Queryable, accountId: string, prevHash: string): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from audit_event where account_id = $1 and action in ('audit.deleted', 'audit.retention_swept')
        and detail->>'anchorHash' = $2 limit 1`,
    [accountId, prevHash],
  );
  return rows.length > 0;
}

export async function selectAuditPurgeAnchor(db: Queryable, accountId: string, before: Date): Promise<Row | undefined> {
  const { rows } = await db.query(
    `select hash, seq, count(*) over () as n from audit_event
      where account_id = $1 and occurred_at < $2 order by seq desc limit 1`,
    [accountId, before],
  );
  return rows[0];
}

export async function purgeAuditEventRows(db: Queryable, accountId: string, before: Date): Promise<number> {
  const { rows: purged } = await db.query("select audit_event_purge($1, $2) as n", [accountId, before]);
  return Number(purged[0]?.["n"] ?? 0);
}
