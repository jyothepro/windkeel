import type { Pool } from "pg";
import { refreshJiraWebhooks, type JiraRefreshResult, type JiraWebhookDeps } from "../../integrations/jira.js";
import { withSweepLock, type LockOutcome } from "./advisory-lock.js";

const JIRA_WEBHOOK_REFRESH_SWEEP = "jira-webhook-refresh";

export async function refreshJiraWebhooksLocked(
  pool: Pool,
  deps: JiraWebhookDeps,
): Promise<LockOutcome<JiraRefreshResult>> {
  return withSweepLock(pool, JIRA_WEBHOOK_REFRESH_SWEEP, () => refreshJiraWebhooks(pool, deps));
}
