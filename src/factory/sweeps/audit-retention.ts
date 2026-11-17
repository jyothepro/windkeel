import type { Pool } from "pg";
import type { Log } from "../stage-wiring.js";
import { auditRetentionDaysFromEnv, purgeAuditEvents, SYSTEM_ACTOR } from "../audit-log.js";
import { withSweepLock, type LockOutcome } from "./advisory-lock.js";
import { deleteStaleSessionActivity, selectAccountsPastAuditRetention } from "./stores/audit-sweep-store.js";

const AUDIT_RETENTION_SWEEP = "audit-retention";

const SESSION_ACTIVITY_RETENTION_DAYS = 31;

export interface AuditRetentionDeps {
  pool: Pool;
  defaultDays?: number;
  now?: Date;
  log?: Log;
}

export interface AuditRetentionResult {
  accounts: Array<{ accountId: string; retentionDays: number; deleted: number }>;
  sessionsPruned: number;
}

export async function sweepAuditRetention(deps: AuditRetentionDeps): Promise<AuditRetentionResult> {
  const defaultDays = deps.defaultDays ?? auditRetentionDaysFromEnv();
  const now = deps.now ?? new Date();
  const rows = await selectAccountsPastAuditRetention(deps.pool, defaultDays, now);
  const accounts: AuditRetentionResult["accounts"] = [];
  for (const row of rows) {
    const retentionDays = Number(row["days"]);
    const before = new Date(now.getTime() - retentionDays * 86_400_000);
    const { deleted } = await purgeAuditEvents(deps.pool, {
      accountId: row["id"] as string,
      before,
      actor: SYSTEM_ACTOR,
      reason: "retention",
      detail: { retentionDays },
    });
    accounts.push({ accountId: row["id"] as string, retentionDays, deleted });
    if (deleted > 0) deps.log?.("pruned audit events", { accountId: row["id"], deleted, retentionDays });
  }
  const sessionsPruned = await deleteStaleSessionActivity(deps.pool, now, SESSION_ACTIVITY_RETENTION_DAYS);
  return { accounts, sessionsPruned };
}

export async function sweepAuditRetentionLocked(deps: AuditRetentionDeps): Promise<LockOutcome<AuditRetentionResult>> {
  return withSweepLock(deps.pool, AUDIT_RETENTION_SWEEP, () => sweepAuditRetention(deps));
}
