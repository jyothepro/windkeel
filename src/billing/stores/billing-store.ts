

import type { QueryResult } from "pg";
import type { Queryable } from "../../factory/db/transaction.js";
import { BILLED_OVERAGE_SQL } from "./credit-ledger-store.js";

export function selectBillingAccount(db: Queryable, accountId: string): Promise<QueryResult> {
  return db.query("select * from billing_account where account_id = $1", [accountId]);
}

export function selectBillingAccountForOrganization(db: Queryable, organizationId: string): Promise<QueryResult> {
  return db.query(
    `select b.*, o.account_id as org_account_id, a.name as account_name
       from organization o join account a on a.id = o.account_id
       left join billing_account b on b.account_id = o.account_id
      where o.id = $1`,
    [organizationId],
  );
}

export function setBillingCustomerIfUnset(db: Queryable, accountId: string, customerId: string): Promise<QueryResult> {
  return db.query(
    `update billing_account set provider_customer_id = $2, updated_at = now()
      where account_id = $1 and provider_customer_id is null`,
    [accountId, customerId],
  );
}

export function lockBillingStatusByCustomer(db: Queryable, provider: string, customerId: string): Promise<QueryResult> {
  return db.query(
    `select account_id, status_event_at, subscription_ended from billing_account
      where provider = $1 and provider_customer_id = $2 for update`,
    [provider, customerId],
  );
}

export function updateBillingStatus(
  db: Queryable,
  accountId: string,
  status: string,
  reason: string,
  at: Date,
  isSubscriptionEvent: boolean,
  ended: boolean,
): Promise<QueryResult> {
  return db.query(
    `update billing_account
        set status = $2, status_reason = $3, status_event_at = $4,
            subscription_ended = case when $5::boolean then $6::boolean else subscription_ended end,
            updated_at = now()
      where account_id = $1`,
    [accountId, status, reason, at, isSubscriptionEvent, ended],
  );
}

export function selectBillingStatusOfOrganization(db: Queryable, organizationId: string): Promise<QueryResult> {
  return db.query(
    `select b.status from organization o join billing_account b on b.account_id = o.account_id where o.id = $1`,
    [organizationId],
  );
}

export function lockCreditAccountByCustomer(db: Queryable, provider: string, customerId: string): Promise<QueryResult> {
  return db.query(
    `select account_id, credit_plan, credit_period_end from billing_account
      where provider = $1 and provider_customer_id = $2 for update`,
    [provider, customerId],
  );
}

export function linkSubscription(db: Queryable, accountId: string, subscriptionId: string | null): Promise<QueryResult> {
  return db.query(
    `update billing_account set provider_subscription_id = coalesce($2, provider_subscription_id), updated_at = now() where account_id = $1`,
    [accountId, subscriptionId],
  );
}

export function setCreditPlanPeriod(
  db: Queryable,
  accountId: string,
  plan: string,
  start: Date,
  end: Date,
  subscriptionId: string | null,
): Promise<QueryResult> {
  return db.query(
    `update billing_account
              set credit_plan = $2, pending_credit_plan = null, credit_period_start = $3, credit_period_end = $4,
                  provider_subscription_id = coalesce($5, provider_subscription_id), updated_at = now()
            where account_id = $1`,
    [accountId, plan, start, end, subscriptionId],
  );
}

export function clearPendingCreditPlan(db: Queryable, accountId: string): Promise<QueryResult> {
  return db.query(`update billing_account set pending_credit_plan = null, updated_at = now() where account_id = $1`, [accountId]);
}

export function setPendingCreditPlan(db: Queryable, accountId: string, plan: string): Promise<QueryResult> {
  return db.query(`update billing_account set pending_credit_plan = $2, updated_at = now() where account_id = $1`, [accountId, plan]);
}

export function setCreditPlan(db: Queryable, accountId: string, plan: string): Promise<QueryResult> {
  return db.query(
    `update billing_account set credit_plan = $2, pending_credit_plan = null, updated_at = now() where account_id = $1`,
    [accountId, plan],
  );
}

export function endCreditSubscription(db: Queryable, accountId: string): Promise<QueryResult> {
  return db.query(
    `update billing_account
            set credit_plan = null, pending_credit_plan = null, overage_enabled = false, overage_enabled_at = null, updated_at = now()
          where account_id = $1`,
    [accountId],
  );
}

export function claimBillingWebhookEvent(db: Queryable, provider: string, eventId: string, type: string): Promise<QueryResult> {
  return db.query(
    `insert into billing_webhook_event (provider, event_id, type) values ($1, $2, $3)
       on conflict do nothing returning event_id`,
    [provider, eventId, type],
  );
}

export function selectOrganizationBudget(db: Queryable, organizationId: string): Promise<QueryResult> {
  return db.query("select * from organization_budget where organization_id = $1", [organizationId]);
}

export function upsertOrganizationBudget(
  db: Queryable,
  organizationId: string,
  budget: {
    monthlyLimitUsd: number | null;
    alertThresholdPct: number;
    defaultRunCapUsd: number | null;
    includeCustomerKeySpend: boolean;
  },
  updatedByPrincipalId: string | null,
): Promise<QueryResult> {
  return db.query(
    `insert into organization_budget
       (organization_id, monthly_limit_usd, alert_threshold_pct, default_run_cap_usd,
        include_customer_key_spend, updated_by_principal_id, updated_at)
     values ($1, $2, $3, $4, $5, $6, now())
     on conflict (organization_id) do update
       set monthly_limit_usd = excluded.monthly_limit_usd,
           alert_threshold_pct = excluded.alert_threshold_pct,
           default_run_cap_usd = excluded.default_run_cap_usd,
           include_customer_key_spend = excluded.include_customer_key_spend,
           updated_by_principal_id = excluded.updated_by_principal_id,
           updated_at = now()`,
    [
      organizationId,
      budget.monthlyLimitUsd,
      budget.alertThresholdPct,
      budget.defaultRunCapUsd,
      budget.includeCustomerKeySpend,
      updatedByPrincipalId,
    ],
  );
}

export function insertBudgetAlert(
  db: Queryable,
  organizationId: string,
  periodStart: Date,
  thresholdPct: number,
  spentUsd: number,
  limitUsd: number,
): Promise<QueryResult> {
  return db.query(
    `insert into budget_alert (organization_id, period_start, threshold_pct, spent_usd, limit_usd)
       values ($1, $2, $3, $4, $5) on conflict do nothing`,
    [organizationId, periodStart, thresholdPct, spentUsd, limitUsd],
  );
}

export function selectBudgetAlerts(db: Queryable, organizationId: string, periodStart: Date): Promise<QueryResult> {
  return db.query(
    `select threshold_pct, spent_usd, limit_usd, sent_at from budget_alert
      where organization_id = $1 and period_start = $2 order by threshold_pct`,
    [organizationId, periodStart],
  );
}

export function selectUsageRollup(db: Queryable, organizationId: string, start: Date, until: Date): Promise<QueryResult> {
  return db.query(
    `select c.kind,
            c.stage_type,
            coalesce(c.key_source, 'orqon') as key_source,
            w.role as workspace_role,
            coalesce(sum(c.usd), 0) as usd,
            count(*) filter (where c.usd is null) as unpriced,
            coalesce(sum(c.tokens_in) filter (where c.usd is null), 0) as unpriced_in,
            coalesce(sum(c.tokens_out) filter (where c.usd is null), 0) as unpriced_out,
            max(c.seq) as max_seq
       from cost_event c
       join engineering_run r on r.id = c.engineering_run_id
       join engineering_task t on t.id = r.task_id
       left join workspace w on c.stage_type = 'workspace' and w.id = c.stage_id
      where t.organization_id = $1 and c.recorded_at >= $2 and c.recorded_at < $3
      group by 1, 2, 3, 4`,
    [organizationId, start, until],
  );
}

export function countVerificationRuns(db: Queryable, organizationId: string, start: Date, until: Date): Promise<QueryResult> {
  return db.query(
    `select count(*) as runs
       from verification_run v
       join engineering_run r on r.id = v.engineering_run_id
       join engineering_task t on t.id = r.task_id
      where t.organization_id = $1 and v.verdict is not null
        and v.completed_at >= $2 and v.completed_at < $3`,
    [organizationId, start, until],
  );
}

export function selectBilledOrganizations(db: Queryable, provider: string): Promise<QueryResult> {
  return db.query(
    `select o.id as organization_id, o.account_id, a.name as account_name, b.*
       from organization o
       join account a on a.id = o.account_id
       join billing_account b on b.account_id = o.account_id
      where b.provider = $1 and b.plan <> 'internal'
      order by o.created_at, o.id`,
    [provider],
  );
}

export function selectUnsentUsageReports(db: Queryable, organizationId: string, periodStart: Date): Promise<QueryResult> {
  return db.query(
    `select * from usage_report where organization_id = $1 and period_start = $2 and status <> 'sent'
      order by through_cost_event_seq`,
    [organizationId, periodStart],
  );
}

export function selectReportedUsage(db: Queryable, organizationId: string, periodStart: Date): Promise<QueryResult> {
  return db.query(
    `select coalesce(max(cumulative_micro_usd), 0) as cumulative, max(through_cost_event_seq) as through
       from usage_report where organization_id = $1 and period_start = $2`,
    [organizationId, periodStart],
  );
}

export function insertUsageReport(
  db: Queryable,
  report: {
    accountId: string;
    organizationId: string;
    periodStart: Date;
    periodEnd: Date;
    billableMicroUsd: number;
    cumulativeMicroUsd: number;
    unpricedCalls: number;
    throughSeq: string | null;
    idempotencyKey: string;
    provider: string;
  },
): Promise<QueryResult> {
  return db.query(
    `insert into usage_report
       (account_id, organization_id, period_start, period_end, billable_micro_usd, cumulative_micro_usd,
        unpriced_calls, through_cost_event_seq, idempotency_key, provider, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
     on conflict do nothing
     returning *`,
    [
      report.accountId,
      report.organizationId,
      report.periodStart,
      report.periodEnd,
      report.billableMicroUsd,
      report.cumulativeMicroUsd,
      report.unpricedCalls,
      report.throughSeq,
      report.idempotencyKey,
      report.provider,
    ],
  );
}

export function selectBilledOverage(db: Queryable, organizationId: string, start: Date, until: Date): Promise<QueryResult> {
  return db.query(
    `select coalesce(sum(${BILLED_OVERAGE_SQL}), 0) as overage, max(c.seq) as through
       from credit_debit d join cost_event c on c.id = d.cost_event_id
      where d.organization_id = $1 and ${BILLED_OVERAGE_SQL} > 0
        and d.recorded_at >= $2 and d.recorded_at < $3`,
    [organizationId, start, until],
  );
}

export function markUsageReportSent(db: Queryable, id: unknown, providerRef: unknown): Promise<QueryResult> {
  return db.query(
    `update usage_report set status = 'sent', provider_ref = $2, attempts = attempts + 1, sent_at = now(), last_error = null
        where id = $1`,
    [id, providerRef],
  );
}

export function markUsageReportFailed(db: Queryable, id: unknown, reason: string): Promise<QueryResult> {
  return db.query(`update usage_report set status = 'failed', attempts = attempts + 1, last_error = $2 where id = $1`, [id, reason]);
}

export function insertSignupInvite(db: Queryable, codeHash: string, note: string | null, expiresAt: Date): Promise<QueryResult> {
  return db.query(`insert into signup_invite (code_hash, note, expires_at) values ($1, $2, $3) returning id`, [codeHash, note, expiresAt]);
}

export function selectUserIdentity(db: Queryable, provider: string, subject: string): Promise<QueryResult> {
  return db.query("select 1 from user_identity where provider = $1 and subject = $2", [provider, subject]);
}

export function selectPrincipalByGithubUser(db: Queryable, githubUserId: unknown): Promise<QueryResult> {
  return db.query("select 1 from principal where github_user_id = $1", [githubUserId]);
}

export function lockSignupInvite(db: Queryable, codeHash: string): Promise<QueryResult> {
  return db.query(`select id, expires_at, redeemed_at from signup_invite where code_hash = $1 for update`, [codeHash]);
}

export function insertAccount(db: Queryable, name: string): Promise<QueryResult> {
  return db.query(`insert into account (name) values ($1) returning id`, [name]);
}

export function insertOrganization(db: Queryable, accountId: string, name: string): Promise<QueryResult> {
  return db.query(`insert into organization (account_id, name) values ($1, $2) returning id`, [accountId, name]);
}

export function insertUserPrincipal(
  db: Queryable,
  accountId: string,
  displayName: string,
  githubUserId: unknown,
  githubLogin: unknown,
): Promise<QueryResult> {
  return db.query(
    `insert into principal (account_id, kind, display_name, github_user_id, github_login)
       values ($1, 'user', $2, $3, $4) returning id`,
    [accountId, displayName, githubUserId, githubLogin],
  );
}

export function insertUserIdentity(db: Queryable, principalId: string, provider: string, subject: string): Promise<QueryResult> {
  return db.query(`insert into user_identity (principal_id, provider, subject, last_seen_at) values ($1, $2, $3, now())`, [
    principalId,
    provider,
    subject,
  ]);
}

export function selectBuiltInAdminRole(db: Queryable): Promise<QueryResult> {
  return db.query(`select id from access_role where key = 'admin' and account_id is null`);
}

export function insertMembership(db: Queryable, organizationId: string, principalId: string, accessRoleId: string): Promise<QueryResult> {
  return db.query(`insert into membership (organization_id, principal_id, access_role_id) values ($1, $2, $3)`, [
    organizationId,
    principalId,
    accessRoleId,
  ]);
}

export function insertAccountMembership(db: Queryable, accountId: string, principalId: string, accessRoleId: string): Promise<QueryResult> {
  return db.query(`insert into account_membership (account_id, principal_id, access_role_id) values ($1, $2, $3)`, [
    accountId,
    principalId,
    accessRoleId,
  ]);
}

export function insertActiveBillingAccount(db: Queryable, accountId: string, provider: string, plan: string): Promise<QueryResult> {
  return db.query(`insert into billing_account (account_id, provider, plan, status) values ($1, $2, $3, 'active')`, [
    accountId,
    provider,
    plan,
  ]);
}

export function redeemSignupInvite(db: Queryable, inviteId: unknown, principalId: string, accountId: string): Promise<QueryResult> {
  return db.query(
    `update signup_invite set redeemed_at = now(), redeemed_by_principal_id = $2, redeemed_account_id = $3 where id = $1`,
    [inviteId, principalId, accountId],
  );
}

export function insertInstallState(
  db: Queryable,
  stateHash: string,
  organizationId: string,
  principalId: string,
  expiresAt: Date,
): Promise<QueryResult> {
  return db.query(
    `insert into github_install_state (state_hash, organization_id, principal_id, expires_at) values ($1, $2, $3, $4)`,
    [stateHash, organizationId, principalId, expiresAt],
  );
}

export function lockInstallState(db: Queryable, stateHash: string): Promise<QueryResult> {
  return db.query(
    `select s.organization_id, s.principal_id, s.expires_at, s.used_at, o.account_id
         from github_install_state s join organization o on o.id = s.organization_id
        where s.state_hash = $1 for update of s`,
    [stateHash],
  );
}

export function markInstallStateUsed(db: Queryable, stateHash: string): Promise<QueryResult> {
  return db.query(`update github_install_state set used_at = now() where state_hash = $1`, [stateHash]);
}

export function claimScmConnection(db: Queryable, accountId: string, installationId: number): Promise<QueryResult> {
  return db.query(
    `insert into scm_connection (account_id, installation_id) values ($1, $2)
       on conflict (provider, installation_id) do nothing returning account_id`,
    [accountId, installationId],
  );
}

export function selectGithubConnectionOwner(db: Queryable, installationId: number): Promise<QueryResult> {
  return db.query(`select account_id from scm_connection where provider = 'github' and installation_id = $1`, [installationId]);
}

export function grantUnclaimedInstallationRepositories(
  db: Queryable,
  organizationId: string,
  installationId: number,
  principalId: string,
): Promise<QueryResult> {
  return db.query(
    `insert into repository_grant (organization_id, repository_id, intake, created_by_principal_id)
         select $1, r.id, not exists (select 1 from repository_grant g where g.repository_id = r.id and g.intake), $3
           from repository r
          where r.github_installation_id = $2
            and not exists (select 1 from repository_grant g where g.repository_id = r.id)
       on conflict do nothing`,
    [organizationId, installationId, principalId],
  );
}
