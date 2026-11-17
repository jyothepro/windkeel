import type { Pool } from "pg";
import { registerLinearNotifier } from "../../integrations/linear.js";
import { VercelConnectTokenSource } from "../../integrations/vercel-connect.js";
import type { ProviderTokenSource } from "../../integrations/token-source.js";
import { unregisterSourceNotifier } from "../../intake/notifiers.js";
import { defaultLog, type IntakeLog } from "../log.js";
import { LINEAR_SOURCE_TYPE } from "../../integrations/linear.js";
import { JIRA_SOURCE_TYPE, registerJiraNotifier } from "../../integrations/jira-intake.js";
import { registerSlackNotifier, SLACK_SOURCE } from "../../intake/slack.js";
import type { GitHubClient } from "../../github/client.js";
import { GITHUB_ISSUE_SOURCE } from "../issue-intake.js";
import { registerGitHubNotifier } from "./github-notifier.js";
import { registerSentryNotifier, SENTRY_CONNECT_ENV, SENTRY_SOURCE_TYPE } from "../../integrations/sentry.js";

export interface DeploymentNotifierDeps {
  pool: Pool;
  env: Record<string, string | undefined>;
  log?: IntakeLog;
  tokenSource?: ProviderTokenSource;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  sentryPrivateKeys?: () => readonly string[];
  github?: GitHubClient;
}

export function registerDeploymentNotifiers(deps: DeploymentNotifierDeps): string[] {
  const log = deps.log ?? defaultLog;
  const registered: string[] = [];
  const tokenSource = (): ProviderTokenSource => deps.tokenSource ?? new VercelConnectTokenSource();

  if (deps.github) {
    registerGitHubNotifier({ pool: deps.pool, github: deps.github, log });
    registered.push(GITHUB_ISSUE_SOURCE);
  } else {
    unregisterSourceNotifier(GITHUB_ISSUE_SOURCE);
  }
  if (deps.env["WINDKEEL_CONNECT_LINEAR"]?.trim()) {
    registerLinearNotifier({ pool: deps.pool, tokenSource: tokenSource(), log, ...(deps.fetch ? { fetch: deps.fetch as typeof fetch } : {}) });
    registered.push(LINEAR_SOURCE_TYPE);
  } else {
    unregisterSourceNotifier(LINEAR_SOURCE_TYPE);
  }
  if (deps.env["WINDKEEL_CONNECT_JIRA"]?.trim()) {
    registerJiraNotifier({ pool: deps.pool, tokens: tokenSource(), log, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    registered.push(JIRA_SOURCE_TYPE);
  } else {
    unregisterSourceNotifier(JIRA_SOURCE_TYPE);
  }
  if (deps.env["WINDKEEL_CONNECT_SLACK"]?.trim()) {
    registerSlackNotifier({ pool: deps.pool, tokenSource: tokenSource(), log, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    registered.push(SLACK_SOURCE);
  } else {
    unregisterSourceNotifier(SLACK_SOURCE);
  }
  if (deps.env[SENTRY_CONNECT_ENV]?.trim()) {
    registerSentryNotifier({ pool: deps.pool, log, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.sentryPrivateKeys ? { privateKeys: deps.sentryPrivateKeys } : {}) });
    registered.push(SENTRY_SOURCE_TYPE);
  } else {
    unregisterSourceNotifier(SENTRY_SOURCE_TYPE);
  }

  return registered;
}
