import "../src/env-compat.js";
import { Pool } from "pg";
import { loadWorkerConfig } from "@windkeel/factory/runs";
import { S3EvidenceStorage } from "@windkeel/factory/execution";
import { createRetentionScheduler } from "@windkeel/factory/ops";
import { reapSandboxesLocked } from "@windkeel/factory/ops";
import { recoverStrandedSignalsLocked } from "@windkeel/factory/ops";
import { pruneIgnoredDeliveriesLocked } from "@windkeel/factory/ops";
import { requeueStrandedCreatedRunsLocked } from "@windkeel/factory/ops";
import { reclaimStalledRunsLocked } from "@windkeel/factory/ops";
import {
  VercelWorkflowProvider,
  startEnvironmentSnapshotBuild,
  startModelCredentialValidation,
} from "@windkeel/factory/workflow";
import { restartUnverifiedCredentialChecksLocked } from "@windkeel/factory/ops";
import { settleStaleMergesLocked } from "@windkeel/factory/ops";
import { refreshJiraWebhooksLocked } from "@windkeel/factory/ops";
import { sweepAuditRetentionLocked } from "@windkeel/factory/ops";
import { auditSinkFromEnv, forwardAuditEventsLocked } from "@windkeel/factory/ops";
import { VercelConnectTokenSource } from "@windkeel/factory/integrations";
import { buildSandboxProvider } from "@windkeel/factory/execution";
import { sweepEnvironmentSnapshotsLocked } from "@windkeel/factory/ops";
import type { SandboxProvider } from "@windkeel/factory/sandbox";
import { defaultLog, describeError } from "@windkeel/factory/intake";
import { authorisedCron } from "../src/cron-route.js";
import { schemaRefusal } from "../src/schema-gate.js";
import { reportPendingUsageLocked } from "@windkeel/factory/billing";
import { loadBillingConfig } from "@windkeel/factory/billing";
import { billingProviderFromConfig } from "@windkeel/factory/billing";

const log = defaultLog;

type IntakePruneOutcome =
  | Awaited<ReturnType<typeof pruneIgnoredDeliveriesLocked>>
  | { kind: "failed"; reason: string };

export async function pruneIntakeDeliveries(pool: Pool): Promise<IntakePruneOutcome> {
  try {
    const intake = await pruneIgnoredDeliveriesLocked({ pool, log });
    log("intake delivery retention", { outcome: intake.kind, ...intake });
    return intake;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log("intake delivery retention failed", { reason });
    return { kind: "failed", reason };
  }
}

type JiraRefreshOutcome =
  | Awaited<ReturnType<typeof refreshJiraWebhooksLocked>>
  | { kind: "failed"; reason: string };

export async function refreshJiraWebhooksStep(pool: Pool): Promise<JiraRefreshOutcome> {
  try {
    const jira = await refreshJiraWebhooksLocked(pool, { tokens: new VercelConnectTokenSource(), log });
    log("jira webhook refresh", { outcome: jira.kind, ...jira });
    return jira;
  } catch (err) {
    const described = describeError(err);
    log("jira webhook refresh failed", described);
    return { kind: "failed", reason: described.errorName };
  }
}

type CredentialChecksOutcome =
  | Awaited<ReturnType<typeof restartUnverifiedCredentialChecksLocked>>
  | { kind: "failed"; reason: string };

export async function restartCredentialChecks(pool: Pool): Promise<CredentialChecksOutcome> {
  try {
    const checks = await restartUnverifiedCredentialChecksLocked({
      pool,
      startValidation: (organizationId, credentialId) => startModelCredentialValidation(organizationId, credentialId),
      log,
    });
    log("unverified model credentials", { outcome: checks.kind, ...checks });
    return checks;
  } catch (err) {
    const reason = err instanceof Error ? err.name : "unknown";
    log("unverified model credentials failed", { reason });
    return { kind: "failed", reason };
  }
}

type AuditOutcome = { kind: string; [key: string]: unknown };

export async function auditRetentionStep(pool: Pool): Promise<AuditOutcome> {
  try {
    const outcome = await sweepAuditRetentionLocked({ pool, log });
    log("audit retention", {
      outcome: outcome.kind,
      ...(outcome.kind === "ran" ? { deleted: outcome.result.accounts.reduce((n, a) => n + a.deleted, 0) } : outcome),
    });
    return outcome;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log("audit retention failed", { reason });
    return { kind: "failed", reason };
  }
}

export async function auditSinkStep(pool: Pool): Promise<AuditOutcome> {
  try {
    const sink = auditSinkFromEnv();
    if (!sink) return { kind: "unconfigured" };
    const outcome = await forwardAuditEventsLocked({ pool, sink, log });
    log("audit sink", { outcome: outcome.kind, ...(outcome.kind === "ran" ? outcome.result : outcome) });
    return outcome;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log("audit sink failed", { reason });
    return { kind: "failed", reason };
  }
}

type StaleMergesOutcome =
  | Awaited<ReturnType<typeof settleStaleMergesLocked>>
  | { kind: "failed"; reason: string };

export async function settleStaleMergesStep(pool: Pool): Promise<StaleMergesOutcome> {
  try {
    const merges = await settleStaleMergesLocked({ pool, log });
    log("stale merges", { outcome: merges.kind, ...(merges.kind === "ran" ? { settled: merges.result.settled.length } : merges) });
    return merges;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log("stale merges failed", { reason });
    return { kind: "failed", reason };
  }
}

type EnvironmentOutcome =
  | { kind: "ran"; abandoned: number; expired: number; deleted: number; dispatched: number }
  | { kind: "contended" | "off" }
  | { kind: "failed"; reason: string };

export async function sweepEnvironmentSnapshotsStep(
  pool: Pool,
  config: ReturnType<typeof loadWorkerConfig>,
  provider: SandboxProvider,
): Promise<EnvironmentOutcome> {
  try {
    const outcome = await sweepEnvironmentSnapshotsLocked({
      pool,
      providers: { [provider.name]: provider },
      startBuild: config.environmentSnapshots?.enabled
        ? (organizationId: string, repositoryId: string) => startEnvironmentSnapshotBuild(organizationId, repositoryId)
        : undefined,
      log,
    });
    if (outcome.kind !== "ran") return { kind: "contended" };
    const r = outcome.result;
    const result: EnvironmentOutcome = {
      kind: "ran",
      abandoned: r.abandoned.length,
      expired: r.expired.length,
      deleted: r.deleted.length,
      dispatched: r.dispatched.length,
    };
    log("environment snapshots", result);
    return result;
  } catch (err) {
    const reason = err instanceof Error ? err.name : "unknown";
    log("environment snapshots failed", { reason });
    return { kind: "failed", reason };
  }
}

type UsageReportOutcome =
  | Awaited<ReturnType<typeof reportPendingUsageLocked>>
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string };

export async function reportUsageStep(pool: Pool): Promise<UsageReportOutcome> {
  try {
    const config = loadBillingConfig();
    const provider = billingProviderFromConfig(config);
    if (!provider) return { kind: "skipped", reason: "WINDKEEL_BILLING_PROVIDER=none" };
    const outcome = await reportPendingUsageLocked({ pool, provider, pricing: config.pricing, log });
    log("usage report", {
      outcome: outcome.kind,
      ...(outcome.kind === "ran"
        ? { reports: outcome.result.reports.length, failed: outcome.result.reports.filter((r) => r.status === "failed").length }
        : {}),
    });
    return outcome;
  } catch (err) {
    const reason = err instanceof Error ? err.name : "unknown";
    log("usage report failed", { reason });
    return { kind: "failed", reason };
  }
}

type StrandedOutcome =
  | Awaited<ReturnType<typeof requeueStrandedCreatedRunsLocked>>
  | { kind: "failed"; reason: string };

export async function requeueStrandedRuns(pool: Pool, connectionString: string): Promise<StrandedOutcome> {
  try {
    const runs = new VercelWorkflowProvider({ connectionString, log });
    await runs.start();
    try {
      const stranded = await requeueStrandedCreatedRunsLocked({
        pool,
        startRun: async (id) => ({ enqueued: (await runs.startRun(id)).enqueued }),
        log,
      });
      log("stranded created runs", { outcome: stranded.kind, ...stranded });
      return stranded;
    } finally {
      await runs.stop().catch(() => {});
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log("stranded created runs failed", { reason });
    return { kind: "failed", reason };
  }
}

type StalledOutcome =
  | Awaited<ReturnType<typeof reclaimStalledRunsLocked>>
  | { kind: "failed"; reason: string };

export async function reclaimStalledRuns(
  pool: Pool,
  connectionString: string,
  pollIntervalMs: number,
): Promise<StalledOutcome> {
  try {
    const runs = new VercelWorkflowProvider({ connectionString, log });
    await runs.start();
    try {
      const stalled = await reclaimStalledRunsLocked({
        pool,
        reclaim: (id, options) => runs.reclaimStalled(id, options),
        pollIntervalMs,
        log,
      });
      log("stalled runs", { outcome: stalled.kind, ...stalled });
      return stalled;
    } finally {
      await runs.stop().catch(() => {});
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log("stalled runs failed", { reason });
    return { kind: "failed", reason };
  }
}

export default async function handler(
  req: { headers: Record<string, string | string[] | undefined> },
  res: {
    status: (code: number) => typeof res;
    json: (body: unknown) => void;
  },
): Promise<void> {
  const header = req.headers["authorization"];
  if (!authorisedCron(header)) {
    res.status(401).json({ ok: false });
    return;
  }

  const config = loadWorkerConfig();
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
  const refusal = await schemaRefusal(pool);
  if (refusal) {
    log("sweep refused", { code: refusal.code, pending: refusal.pending });
    res.status(503).json(refusal);
    await pool.end().catch(() => {});
    return;
  }
  let intake: IntakePruneOutcome | undefined;
  let stranded: StrandedOutcome | undefined;
  let jira: JiraRefreshOutcome | undefined;
  let credentials: CredentialChecksOutcome | undefined;
  let merges: StaleMergesOutcome | undefined;
  let stalled: StalledOutcome | undefined;
  let environments: EnvironmentOutcome | undefined;
  let audit: AuditOutcome | undefined;
  let auditSink: AuditOutcome | undefined;
  let usage: UsageReportOutcome | undefined;
  try {
    const storage = config.evidence ? new S3EvidenceStorage(config.evidence) : undefined;

    const retention = await createRetentionScheduler({
      pool,
      storage,
      makerScreenshotBucket: config.evidence?.bucket,
      intervalMs: config.retentionSweepIntervalMs,
      log,
    }).sweepOnce();
    log("retention sweep", {
      outcome: retention.kind,
      ...retention,
      ...(retention.kind === "swept"
        ? {
            pruned: retention.prunedIds.length,
            capturesPruned: retention.capturePrunedRunIds.length,
            makerScreenshotsPruned: retention.makerScreenshotsPruned,
          }
        : {}),
    });

    stalled = await reclaimStalledRuns(
      pool,
      config.poolDatabaseUrl ?? config.databaseUrl,
      config.railsCheckIntervalMs,
    );

    const { provider } = buildSandboxProvider(config, log);
    const reap = await reapSandboxesLocked({
      pool,
      providers: { [provider.name]: provider },
      log,
    });
    log("sandbox reap", { outcome: reap.kind, ...reap });
    environments = await sweepEnvironmentSnapshotsStep(pool, config, provider);

    const runs = new VercelWorkflowProvider({
      connectionString: config.poolDatabaseUrl ?? config.databaseUrl,
      log,
    });
    await runs.start();
    let signals;
    try {
      signals = await recoverStrandedSignalsLocked({
        pool,
        recoverStranded: (id) => runs.recoverStranded(id),
        log,
      });
      log("signal recovery", { outcome: signals.kind, ...signals });
    } finally {
      await runs.stop().catch(() => {});
    }

    stranded = await requeueStrandedRuns(pool, config.poolDatabaseUrl ?? config.databaseUrl);
    intake = await pruneIntakeDeliveries(pool);
    jira = await refreshJiraWebhooksStep(pool);
    credentials = await restartCredentialChecks(pool);
    merges = await settleStaleMergesStep(pool);
    audit = await auditRetentionStep(pool);
    auditSink = await auditSinkStep(pool);
    usage = await reportUsageStep(pool);
    res.status(200).json({ ok: true, retention, stalled, reap, environments, signals, stranded, intake, jira, credentials, merges, audit, auditSink, usage });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log("sweep failed", { reason });
    stalled ??= await reclaimStalledRuns(
      pool,
      config.poolDatabaseUrl ?? config.databaseUrl,
      config.railsCheckIntervalMs,
    );
    stranded ??= await requeueStrandedRuns(pool, config.poolDatabaseUrl ?? config.databaseUrl);
    intake ??= await pruneIntakeDeliveries(pool);
    jira ??= await refreshJiraWebhooksStep(pool);
    credentials ??= await restartCredentialChecks(pool);
    merges ??= await settleStaleMergesStep(pool);
    audit ??= await auditRetentionStep(pool);
    auditSink ??= await auditSinkStep(pool);
    usage ??= await reportUsageStep(pool);
    res.status(500).json({ ok: false, reason, stalled, stranded, intake, jira, credentials, merges, audit, auditSink, usage });
  } finally {
    await pool.end().catch(() => {});
  }
}
