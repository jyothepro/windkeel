

import type { Pool, PoolClient } from "pg";
import { defaultLog, describeError, redactSecrets, type IntakeLog } from "../factory/log.js";
import { WINDKEEL_ADVISORY_NAMESPACE, sweepLockKey } from "../factory/sweeps/advisory-lock.js";
import { rowToConnection, type IntegrationConnection } from "./connections.js";
import { selectConnectionById } from "./stores/connections-store.js";
import {
  clearDirtyThrough,
  clearLocalLockTimeout,
  deleteDirtyMark,
  deleteJiraWebhookRow,
  dropRetiredWebhookIds,
  lockConnectionXact,
  markConnectionDirty,
  recordJiraRefresh,
  recordJiraUnchanged,
  selectActiveJiraConnections,
  selectConnectionStatus,
  selectDirtyGeneration,
  selectEnabledRouteScopes,
  selectGoneJiraConnections,
  selectJiraWebhookRow,
  selectSchema,
  setJiraWebhookError,
  setLocalLockTimeout,
  upsertJiraWebhook,
} from "./stores/jira-store.js";
import { withTransaction } from "../factory/db/transaction.js";
import { type ProviderTokenSource } from "./token-source.js";
import {
  type FetchLike,
  JIRA_INTERACTIVE_TIMEOUT_MS,
  JiraClient,
  type JiraTarget,
  type Queryable,
  jiraSiteUrl,
  withJiraClient,
} from "./jira-client.js";

export {
  JIRA_API_BASE,
  JIRA_WEBHOOK_EVENTS,
  JIRA_INTERACTIVE_TIMEOUT_MS,
  JIRA_WEBHOOK_SECRET_ENV,
  JWT_LEEWAY_SECONDS,
  JWT_MAX_LIFETIME_SECONDS,
  verifyJiraWebhookJwt,
  signJiraWebhookJwt,
  jiraCloudIdFromSelf,
  jiraSiteOrigin,
  JiraApiError,
  JiraTimeoutError,
  JiraClient,
  jiraSiteUrl,
  withJiraClient,
  resolveJiraCloudId,
} from "./jira-client.js";
export type {
  FetchLike,
  JwtVerdict,
  JiraWebhook,
  JiraCallOptions,
  JiraTarget,
  JiraWebhookPayload,
} from "./jira-client.js";

const JIRA_WEBHOOK_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

const JIRA_REFRESH_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;

const JIRA_INTAKE_PATH = "/api/intake/jira";

const JIRA_SWEEP_TIMEOUT_MS = 10_000;

const JIRA_SWEEP_BUDGET_MS = 120_000;

const JIRA_SWEEP_MAX_CONNECTIONS = 50;

const JIRA_LOCK_TIMEOUT_MS = 10_000;

const JIRA_JQL_PROJECTS_PER_WEBHOOK = 100;
const JIRA_MAX_WEBHOOKS_PER_CONNECTION = 2;

export interface JiraWebhookDeps {
  tokens: ProviderTokenSource;
  fetch?: FetchLike;

  publicUrl?: string | undefined;
  now?: () => Date;
  refreshWithinMs?: number;

  timeoutMs?: number;

  lockTimeoutMs?: number;

  signal?: AbortSignal;

  deadline?: number;
  log?: IntakeLog;
}

const JIRA_DIRTY_RERUNS = 2;

export interface JiraWebhookRow {
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

export type EnsureOutcome =
  | { kind: "registered"; webhookIds: number[]; jql: string }
  | { kind: "refreshed"; expiresAt: Date }
  | { kind: "unchanged" }
  | { kind: "removed" }
  | { kind: "failed"; reason: string };

export async function getJiraWebhook(db: Queryable, connectionId: string): Promise<JiraWebhookRow | null> {
  const { rows } = await selectJiraWebhookRow(db, connectionId);
  const row = rows[0];
  if (!row) return null;
  return {
    connectionId: row.connection_id,
    cloudId: row.cloud_id,
    siteUrl: row.site_url ?? null,
    webhookIds: (row.webhook_ids as Array<string | number>).map(Number),
    retiredWebhookIds: ((row.retired_webhook_ids ?? []) as Array<string | number>).map(Number),
    jql: row.jql,
    expiresAt: row.expires_at,
    lastRefreshedAt: row.last_refreshed_at ?? null,
    lastError: row.last_error ?? null,
  };
}

function jqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function distinctKeys(keys: readonly string[]): string[] {
  return [...new Set(keys.map((k) => k.trim()).filter((k) => k.length > 0))].sort();
}

export function projectJql(keys: readonly string[]): string | null {
  const unique = distinctKeys(keys);
  return unique.length === 0 ? null : `project IN (${unique.map(jqlString).join(", ")})`;
}

export function projectJqlFilters(keys: readonly string[]): { filters: string[]; dropped: number } {
  const unique = distinctKeys(keys);
  const cap = JIRA_JQL_PROJECTS_PER_WEBHOOK * JIRA_MAX_WEBHOOKS_PER_CONNECTION;
  const kept = unique.slice(0, cap);
  const filters: string[] = [];
  for (let i = 0; i < kept.length; i += JIRA_JQL_PROJECTS_PER_WEBHOOK) {
    filters.push(projectJql(kept.slice(i, i + JIRA_JQL_PROJECTS_PER_WEBHOOK))!);
  }
  return { filters, dropped: unique.length - kept.length };
}

function jiraWebhookUrl(publicUrl: string | undefined): string | null {
  const base = publicUrl?.trim().replace(/\/+$/, "");
  if (!base || !/^https:\/\//.test(base)) return null;
  return `${base}${JIRA_INTAKE_PATH}`;
}

class LockBusy extends Error {
  override readonly name = "LockBusy";
}

interface LockedTransaction {
  db: PoolClient;

  afterCommit(step: (db: Queryable) => Promise<void>): void;

  onRollback(step: () => Promise<void>): void;
}

async function withConnectionLock<T>(
  pool: Pool,
  connectionId: string,
  lockTimeoutMs: number,
  log: IntakeLog,
  fn: (tx: LockedTransaction) => Promise<T>,
): Promise<T> {
  const afterCommit: Array<(db: Queryable) => Promise<void>> = [];
  const onRollback: Array<(db: Queryable) => Promise<void>> = [];
  const run = async (steps: Array<(db: Queryable) => Promise<void>>, phase: string): Promise<void> => {
    for (const step of steps) {
      await step(pool).catch((error: unknown) => log(`jira webhook ${phase} step failed`, { connectionId, ...describeError(error) }));
    }
  };
  let result: T;
  try {
    result = await withTransaction(pool, async (client) => {
      const { rows } = await selectSchema(client);
      const key = sweepLockKey(`jira-webhook:${connectionId}`, rows[0]?.schema ?? "public");
      await setLocalLockTimeout(client, `${Math.max(1, lockTimeoutMs)}ms`);
      try {
        await lockConnectionXact(client, WINDKEEL_ADVISORY_NAMESPACE, key);
      } catch (error) {
        if ((error as { code?: unknown }).code === "55P03") throw new LockBusy("another ensure holds this connection");
        throw error;
      }
      await clearLocalLockTimeout(client);
      return fn({
        db: client,
        afterCommit: (step) => void afterCommit.push(step),
        onRollback: (step) => void onRollback.push(() => step()),
      });
    });
  } catch (error) {

    await run(onRollback, "rollback");
    throw error;
  }
  await run(afterCommit, "after-commit");
  return result;
}

function reasonOf(error: unknown): string {
  return redactSecrets(error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);
}

async function markDirty(db: Queryable, connectionId: string): Promise<void> {
  await markConnectionDirty(db, connectionId);
}

async function dirtyGeneration(db: Queryable, connectionId: string): Promise<number | null> {
  const { rows } = await selectDirtyGeneration(db, connectionId);
  return rows[0] ? Number(rows[0].generation) : null;
}

async function clearDirty(db: Queryable, connectionId: string, covered: number | null): Promise<boolean> {
  if (covered !== null) {
    await clearDirtyThrough(db, connectionId, covered);
  }
  return (await dirtyGeneration(db, connectionId)) !== null;
}

async function readConnection(db: Queryable, connectionId: string): Promise<IntegrationConnection | null> {
  const { rows } = await selectConnectionById(db, connectionId);
  return rows[0] ? rowToConnection(rows[0]) : null;
}

function union(...lists: ReadonlyArray<readonly number[]>): number[] {
  return [...new Set(lists.flat())];
}

export async function ensureJiraWebhook(
  pool: Pool,
  connection: IntegrationConnection,
  deps: JiraWebhookDeps,
): Promise<EnsureOutcome> {
  if (connection.provider !== "jira" || connection.status !== "active") return { kind: "unchanged" };
  const log = deps.log ?? defaultLog;
  const lockTimeoutMs = deps.lockTimeoutMs ?? JIRA_LOCK_TIMEOUT_MS;
  let current = connection;
  let outcome: EnsureOutcome = { kind: "unchanged" };
  for (let pass = 0; pass <= JIRA_DIRTY_RERUNS; pass += 1) {
    let covered: number | null;
    try {
      ({ outcome, covered } = await withConnectionLock(pool, current.id, lockTimeoutMs, log, (tx) =>
        ensureLocked(tx, current, deps),
      ));
    } catch (error) {
      if (error instanceof LockBusy) {
        await markDirty(pool, current.id).catch((markError: unknown) =>
          log("jira webhook dirty mark failed", { connectionId: current.id, ...describeError(markError) }),
        );
        log("jira webhook ensure failed", { connectionId: current.id, reason: "busy" });

        return pass === 0 ? { kind: "failed", reason: "busy" } : outcome;
      }
      const reason = reasonOf(error);
      log("jira webhook ensure failed", { connectionId: current.id, reason });
      return { kind: "failed", reason };
    }

    let fresh: IntegrationConnection | null;
    try {
      if (!(await clearDirty(pool, current.id, covered))) return outcome;
      fresh = await readConnection(pool, current.id);
    } catch (error) {
      log("jira webhook dirty check failed", { connectionId: current.id, ...describeError(error) });
      return outcome;
    }
    if (!fresh) return outcome;
    if (fresh.status !== "active") {
      const removed = await removeJiraWebhook(pool, fresh, deps);
      return removed.kind === "removed" ? { kind: "removed" } : outcome;
    }
    log("jira webhook ensure re-running for a change made while it ran", { connectionId: current.id });
    current = fresh;
  }
  return outcome;
}

async function ensureLocked(
  tx: LockedTransaction,
  connection: IntegrationConnection,
  deps: JiraWebhookDeps,
): Promise<{ outcome: EnsureOutcome; covered: number | null }> {
  const { db } = tx;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? defaultLog;
  const cloudId = connection.externalTenantId;
  const target: JiraTarget = {
    tokens: deps.tokens,
    installationId: connection.installationId,
    cloudId,
    fetch: deps.fetch,
    timeoutMs: deps.timeoutMs ?? JIRA_INTERACTIVE_TIMEOUT_MS,
  };

  const covered = await dirtyGeneration(db, connection.id);

  const { rows: status } = await selectConnectionStatus(db, connection.id);
  if (status[0]?.status !== "active") return { outcome: { kind: "unchanged" }, covered };

  let row = null as JiraWebhookRow | null;
  let desiredJql = "";

  try {
    return await withTransaction(db, async () => {
      row = await getJiraWebhook(db, connection.id);
      const { rows: routes } = await selectEnabledRouteScopes(db, connection.id);

      if (routes.length === 0) {
        const ours = row ? union(row.webhookIds, row.retiredWebhookIds) : [];
        if (ours.length > 0) {
          await withJiraClient(target, (client) => client.deleteWebhooks(ours), deps.signal);
        }
        if (row) await deleteJiraWebhookRow(db, connection.id);
        return { outcome: row ? { kind: "removed" } : { kind: "unchanged" }, covered };
      }

      const url = jiraWebhookUrl(deps.publicUrl ?? process.env["WINDKEEL_PUBLIC_URL"]);
      if (!url) throw new Error("WINDKEEL_PUBLIC_URL is not set to an https:// URL, so there is nowhere to point the webhook");

      const outcome = await withJiraClient(
        target,
        async (client, token): Promise<EnsureOutcome> => {
          const hasDefault = routes.some((r) => r.scope_kind === "default");
          const keys = hasDefault
            ? await client.listProjectKeys(deps.deadline)
            : routes.filter((r) => r.scope_kind === "jira_project" && r.scope_value).map((r) => r.scope_value!);
          const { filters, dropped } = projectJqlFilters(keys);
          if (filters.length === 0) throw new Error("no Jira project is visible to the app, so there is nothing to watch");
          const jql = filters.join("\n");
          desiredJql = jql;
          const warning =
            dropped > 0
              ? `a default route watches the first ${JIRA_JQL_PROJECTS_PER_WEBHOOK * JIRA_MAX_WEBHOOKS_PER_CONNECTION} ` +
                `projects; ${dropped} more are not watched — add jira_project routes for them`
              : null;

          const live = new Map((await client.listWebhooks()).map((w) => [w.id, w]));
          const stored = row?.webhookIds ?? [];

          let retired = (row?.retiredWebhookIds ?? []).filter((id) => live.has(id) && !stored.includes(id));
          if (retired.length > 0) {
            try {
              await client.deleteWebhooks(retired);
              for (const id of retired) live.delete(id);
              retired = [];
            } catch (error) {
              log("jira retired webhook delete failed", { connectionId: connection.id, ...describeError(error) });
            }
          }

          const intact =
            stored.length === filters.length && stored.every((id) => live.has(id)) && row!.jql === jql;

          if (!intact) {

            const siteUrl =
              row?.siteUrl ??
              (await jiraSiteUrl(token, cloudId, { fetch: deps.fetch, timeoutMs: target.timeoutMs, signal: deps.signal }));
            if (!siteUrl) throw new Error("Jira did not list this site among the app's accessible resources");

            const ids = await client.registerWebhooks(url, filters);
            let undone = false;
            const unregister = async (): Promise<void> => {
              if (undone) return;
              undone = true;
              try {
                await client.deleteWebhooks(ids);
              } catch (error) {

                log("jira webhook registered but neither recorded nor deleted", {
                  connectionId: connection.id,
                  webhookIds: ids.join(","),
                  ...describeError(error),
                });
              }
            };

            tx.onRollback(unregister);
            const registeredAt = now();
            const replaced = union(retired, stored.filter((id) => live.has(id) && !ids.includes(id)));
            try {
              await upsert(db, {
                connectionId: connection.id,
                cloudId,
                siteUrl,
                webhookIds: ids,
                retiredWebhookIds: replaced,
                jql,
                expiresAt: new Date(registeredAt.getTime() + JIRA_WEBHOOK_LIFETIME_MS),
                lastRefreshedAt: registeredAt,
                lastError: warning,
              });
            } catch (error) {
              await unregister();
              throw error;
            }
            if (replaced.length > 0) tx.afterCommit((after) => deleteRetired(after, client, connection.id, replaced, log));
            return { kind: "registered", webhookIds: ids, jql };
          }

          const expiries = stored.map((id) => live.get(id)!.expirationDate).filter((e): e is number => e !== null);
          const expiresAt = expiries.length > 0 ? new Date(Math.min(...expiries)) : row!.expiresAt;
          if (expiresAt.getTime() - now().getTime() <= (deps.refreshWithinMs ?? JIRA_REFRESH_WITHIN_MS)) {
            const extended = new Date(await client.refreshWebhooks(stored));
            await recordJiraRefresh(db, connection.id, extended, now(), warning, retired);
            return { kind: "refreshed", expiresAt: extended };
          }
          await recordJiraUnchanged(db, connection.id, expiresAt, warning, retired);
          return { kind: "unchanged" };
        },
        deps.signal,
      );
      return { outcome, covered };
    });
  } catch (error) {
    const reason = reasonOf(error);
    try {
      if (row) {
        await setJiraWebhookError(db, connection.id, reason);
      } else {

        await upsert(db, {
          connectionId: connection.id,
          cloudId,
          siteUrl: null,
          webhookIds: [],
          retiredWebhookIds: [],
          jql: desiredJql,
          expiresAt: now(),
          lastRefreshedAt: null,
          lastError: reason,
        });
      }
    } catch (recordError) {
      log("jira webhook error could not be recorded", { connectionId: connection.id, ...describeError(recordError) });
    }
    log("jira webhook ensure failed", { connectionId: connection.id, reason });
    return { outcome: { kind: "failed", reason }, covered };
  }
}

async function deleteRetired(
  db: Queryable,
  client: JiraClient,
  connectionId: string,
  ids: number[],
  log: IntakeLog,
): Promise<void> {
  try {
    await client.deleteWebhooks(ids);
  } catch (error) {
    log("jira stale webhook delete failed", { connectionId, ...describeError(error) });
    await setJiraWebhookError(
      db,
      connectionId,
      `the replaced webhook could not be deleted yet (${reasonOf(error)}); the next pass retries`,
    );
    return;
  }
  await dropRetiredWebhookIds(db, connectionId, ids);
}

async function upsert(db: Queryable, row: JiraWebhookRow): Promise<void> {
  await upsertJiraWebhook(db, row);
}

export async function removeJiraWebhook(
  pool: Pool,
  connection: IntegrationConnection,
  deps: JiraWebhookDeps,
): Promise<{ kind: "removed"; atJira: boolean } | { kind: "unchanged" } | { kind: "failed"; reason: string }> {
  const log = deps.log ?? defaultLog;
  if (connection.provider !== "jira") return { kind: "unchanged" };
  try {
    return await withConnectionLock(pool, connection.id, deps.lockTimeoutMs ?? JIRA_LOCK_TIMEOUT_MS, log, async ({ db, afterCommit }) => {

      afterCommit(async (after) => {
        await deleteDirtyMark(after, connection.id);
      });
      const row = await getJiraWebhook(db, connection.id);
      if (!row) return { kind: "unchanged" } as const;
      const ours = union(row.webhookIds, row.retiredWebhookIds);
      let atJira = ours.length === 0;
      if (!atJira) {
        try {
          await withJiraClient(
            {
              tokens: deps.tokens,
              installationId: connection.installationId,
              cloudId: row.cloudId,
              fetch: deps.fetch,
              timeoutMs: deps.timeoutMs ?? JIRA_INTERACTIVE_TIMEOUT_MS,
            },
            (client) => client.deleteWebhooks(ours),
            deps.signal,
          );
          atJira = true;
        } catch (error) {
          log("jira webhook delete on disconnect failed", { connectionId: connection.id, ...describeError(error) });
        }
      }
      await deleteJiraWebhookRow(db, connection.id);
      return { kind: "removed", atJira } as const;
    });
  } catch (error) {
    if (error instanceof LockBusy) {
      await markDirty(pool, connection.id).catch((markError: unknown) =>
        log("jira webhook dirty mark failed", { connectionId: connection.id, ...describeError(markError) }),
      );
    }
    const reason = error instanceof LockBusy ? "busy" : reasonOf(error);
    log("jira webhook remove failed", { connectionId: connection.id, reason });
    return { kind: "failed", reason };
  }
}

export interface JiraRefreshResult {
  connections: number;
  registered: number;
  refreshed: number;
  unchanged: number;
  removed: number;
  failed: number;

  reaped: number;

  skipped: number;
}

export interface JiraRefreshOptions {

  budgetMs?: number;

  maxConnections?: number;
}

export async function refreshJiraWebhooks(
  pool: Pool,
  deps: JiraWebhookDeps & JiraRefreshOptions,
): Promise<JiraRefreshResult> {
  const budgetMs = deps.budgetMs ?? JIRA_SWEEP_BUDGET_MS;
  const maxConnections = deps.maxConnections ?? JIRA_SWEEP_MAX_CONNECTIONS;
  const started = performance.now();
  const { rows: gone } = await selectGoneJiraConnections(pool, maxConnections);
  const { rows } = await selectActiveJiraConnections(pool);
  const result: JiraRefreshResult = {
    connections: rows.length,
    registered: 0,
    refreshed: 0,
    unchanged: 0,
    removed: 0,
    failed: 0,
    reaped: 0,
    skipped: 0,
  };
  const ensureDeps: JiraWebhookDeps = {
    ...deps,
    timeoutMs: deps.timeoutMs ?? JIRA_SWEEP_TIMEOUT_MS,
    deadline: deps.deadline ?? started + budgetMs,
  };
  const work = [...gone.map((row) => ({ reap: true, row })), ...rows.map((row) => ({ reap: false, row }))];
  for (const [index, { reap, row }] of work.entries()) {
    if (index >= maxConnections || (index > 0 && performance.now() - started >= budgetMs)) {
      result.skipped = work.length - index;
      break;
    }
    if (reap) {
      const outcome = await removeJiraWebhook(pool, rowToConnection(row), ensureDeps);
      if (outcome.kind === "removed") result.reaped += 1;
      else if (outcome.kind === "failed") result.failed += 1;
      continue;
    }
    const outcome = await ensureJiraWebhook(pool, rowToConnection(row), ensureDeps);
    result[outcome.kind] += 1;
  }
  return result;
}
