

import type { QueryResult } from "pg";
import type { Queryable } from "../../factory/db/transaction.js";

export function costLineSql(where: string, extra: { select?: string; join?: string } = {}): string {
  return `select c.id, c.seq, c.engineering_run_id, c.kind, c.model, c.key_source, c.usd, c.sandbox_ms,
                 c.tokens_in, c.tokens_out, c.stage_type, c.recorded_at,
                 t.organization_id, t.repository_id, w.role as workspace_role${extra.select ? `, ${extra.select}` : ""}
            from cost_event c
            join engineering_run r on r.id = c.engineering_run_id
            join engineering_task t on t.id = r.task_id
            left join workspace w on c.stage_type = 'workspace' and w.id = c.stage_id
            ${extra.join ?? ""}
           where ${where}
           order by c.recorded_at, c.seq`;
}

export function selectCreditAccountRow(db: Queryable, accountId: string): Promise<QueryResult> {
  return db.query("select * from billing_account where account_id = $1", [accountId]);
}

export function lockCreditAccountRow(db: Queryable, accountId: string): Promise<QueryResult> {
  return db.query("select * from billing_account where account_id = $1 for update", [accountId]);
}

export function selectAccountOfOrganization(db: Queryable, organizationId: string): Promise<QueryResult> {
  return db.query("select account_id from organization where id = $1", [organizationId]);
}

export function enableCreditBilling(db: Queryable, accountId: string, at: Date): Promise<QueryResult> {
  return db.query(
    `update billing_account set credit_billing_since = coalesce(credit_billing_since, $2), updated_at = now() where account_id = $1`,
    [accountId, at],
  );
}

export function selectCreditAccountIds(db: Queryable): Promise<QueryResult> {
  return db.query("select account_id from billing_account where credit_billing_since is not null order by account_id");
}

export function selectOverageEligibility(db: Queryable, accountId: string): Promise<QueryResult> {
  return db.query(
    `select credit_billing_since is not null as on_credits,
              credit_plan is not null and provider_subscription_id is not null as subscribed
         from billing_account where account_id = $1`,
    [accountId],
  );
}

export function updateOverageSettings(
  db: Queryable,
  accountId: string,
  enabled: boolean,
  capCredits: number | null,
  at: Date,
): Promise<QueryResult> {
  return db.query(
    `update billing_account
        set overage_enabled = $2,
            overage_enabled_at = case when not $2 then null when overage_enabled then overage_enabled_at else $4 end,
            overage_cap_credits = $3, updated_at = now()
      where account_id = $1 and credit_billing_since is not null`,
    [accountId, enabled, capCredits, at],
  );
}

export function insertCreditGrant(
  db: Queryable,
  grant: {
    accountId: string;
    source: string;
    product: string | null;
    amountMicro: number;
    startsAt: Date;
    expiresAt: Date;
    idempotencyKey: string;
    providerRef: string | null;
  },
): Promise<QueryResult> {
  return db.query(
    `insert into credit_grant (account_id, source, product, amount_micro, starts_at, expires_at, idempotency_key, provider_ref)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (idempotency_key) do nothing
     returning id`,
    [grant.accountId, grant.source, grant.product, grant.amountMicro, grant.startsAt, grant.expiresAt, grant.idempotencyKey, grant.providerRef],
  );
}

export function selectGrantsWithRemaining(db: Queryable, accountId: string, liveAfter: Date): Promise<QueryResult> {
  return db.query(
    `select g.id, g.source, g.product, g.amount_micro, g.starts_at, g.expires_at, g.created_at,
            g.amount_micro - coalesce((select sum(a.amount_micro) from credit_allocation a where a.grant_id = g.id), 0) as remaining
       from credit_grant g
      where g.account_id = $1 and g.expires_at > $2
      order by g.created_at, g.id`,
    [accountId, liveAfter],
  );
}

export function selectUndebitedCostLines(db: Queryable, accountId: string, since: Date, until: Date): Promise<QueryResult> {
  return db.query(
    costLineSql(
      `t.organization_id in (select id from organization where account_id = $1)
         and c.recorded_at >= $2 and c.recorded_at <= $3
         and not exists (select 1 from credit_debit d where d.cost_event_id = c.id)`,
    ),
    [accountId, since, until],
  );
}

export function selectRunCostLinesWithDebits(db: Queryable, runId: string): Promise<QueryResult> {
  return db.query(pricedCostLineSql("c.engineering_run_id = $1"), [runId]);
}

export function selectOrganizationCostLinesWithDebits(db: Queryable, organizationId: string, start: Date, end: Date): Promise<QueryResult> {
  return db.query(pricedCostLineSql("t.organization_id = $1 and c.recorded_at >= $2 and c.recorded_at < $3"), [organizationId, start, end]);
}

function pricedCostLineSql(where: string): string {
  return costLineSql(where, {
    select: "d.amount_micro as debit_micro, d.sandbox_seconds as debit_seconds",
    join: "left join credit_debit d on d.cost_event_id = c.id",
  });
}

export function selectRepositoryNames(db: Queryable, repositoryIds: readonly string[]): Promise<QueryResult> {
  return db.query("select id, owner, name from repository where id = any($1::uuid[])", [repositoryIds]);
}

export const BILLED_OVERAGE_SQL = "coalesce(overage_billable_micro, case when overage_billable then overage_micro else 0 end)";

export function selectOverageInPeriod(db: Queryable, accountId: string, start: Date, end: Date): Promise<QueryResult> {
  return db.query(
    `select coalesce(sum(${BILLED_OVERAGE_SQL}), 0) as billed,
            coalesce(sum(overage_micro - ${BILLED_OVERAGE_SQL}), 0) as unbilled
       from credit_debit where account_id = $1 and recorded_at >= $2 and recorded_at < $3`,
    [accountId, start, end],
  );
}

export function selectDebitedCompute(db: Queryable, runIds: readonly string[]): Promise<QueryResult> {
  return db.query(
    `select d.engineering_run_id,
            coalesce(sum(c.sandbox_ms), 0) as ms,
            coalesce(sum(d.sandbox_seconds), 0) as seconds,
            coalesce(sum(d.amount_micro), 0) as micro
       from credit_debit d
       join cost_event c on c.id = d.cost_event_id
      where d.engineering_run_id = any($1::uuid[]) and d.kind = 'compute'
      group by d.engineering_run_id`,
    [runIds],
  );
}

export interface DebitRow {
  accountId: string;
  organizationId: string;
  costEventId: string;
  engineeringRunId: string;
  repositoryId: string;
  role: string;
  kind: string;
  model: string | null;
  keySource: string | null;
  sandboxSeconds: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  unpriced: boolean;
  amountMicro: number;
  overageMicro: number;
  overageBillableMicro: number;
  recordedAt: Date;
}

export function insertCreditDebit(db: Queryable, d: DebitRow): Promise<QueryResult> {
  return db.query(
    `insert into credit_debit
           (account_id, organization_id, cost_event_id, engineering_run_id, repository_id, role, kind, model, key_source,
            sandbox_seconds, tokens_in, tokens_out, unpriced, amount_micro, overage_micro, overage_billable, recorded_at,
            overage_billable_micro)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         on conflict (cost_event_id) do nothing
         returning id`,
    [
      d.accountId,
      d.organizationId,
      d.costEventId,
      d.engineeringRunId,
      d.repositoryId,
      d.role,
      d.kind,
      d.model,
      d.keySource,
      d.sandboxSeconds,
      d.tokensIn,
      d.tokensOut,
      d.unpriced,
      d.amountMicro,
      d.overageMicro,
      d.overageBillableMicro > 0 && d.overageBillableMicro === d.overageMicro,
      d.recordedAt,
      d.overageBillableMicro,
    ],
  );
}

export function insertCreditAllocation(db: Queryable, debitId: string, grantId: string, amountMicro: number): Promise<QueryResult> {
  return db.query(`insert into credit_allocation (debit_id, grant_id, amount_micro) values ($1, $2, $3)`, [debitId, grantId, amountMicro]);
}

export function insertCreditAlert(
  db: Queryable,
  accountId: string,
  periodStart: Date,
  kind: string,
  usedMicro: number,
  limitMicro: number,
): Promise<QueryResult> {
  return db.query(
    `insert into credit_alert (account_id, period_start, kind, used_micro, limit_micro) values ($1, $2, $3, $4, $5)
       on conflict do nothing`,
    [accountId, periodStart, kind, usedMicro, limitMicro],
  );
}

export function selectCreditAlerts(db: Queryable, accountId: string, periodStart: Date): Promise<QueryResult> {
  return db.query(
    `select kind, period_start, used_micro, limit_micro, raised_at from credit_alert
      where account_id = $1 and period_start = $2 order by raised_at, kind`,
    [accountId, periodStart],
  );
}
