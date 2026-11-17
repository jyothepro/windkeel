import type { Pool } from "pg";
import type { SandboxProvider } from "../../sandbox/provider.js";
import type { Log } from "../stage-wiring.js";
import { claimSnapshotRequests, KEEP_READY_SNAPSHOTS, requestSnapshotBuild } from "../environment-snapshots.js";
import { withSweepLock, type LockOutcome } from "./advisory-lock.js";
import {
  clearProviderSnapshotId,
  expireReadySnapshots,
  failAbandonedSnapshotBuilds,
  selectStaleProviderSnapshots,
} from "./stores/environment-snapshot-sweep-store.js";

const ENVIRONMENT_SNAPSHOT_SWEEP = "environment-snapshots";
const DEFAULT_BUILDING_TIMEOUT_MS = 3 * 60 * 60 * 1000;

export interface EnvironmentSnapshotSweepDeps {
  pool: Pool;
  providers: Record<string, SandboxProvider>;
  buildingTimeoutMs?: number;
  keep?: number;
  startBuild?: ((organizationId: string, repositoryId: string) => Promise<unknown>) | undefined;
  dispatchLimit?: number;
  log?: Log;
}

export interface EnvironmentSnapshotSweepResult {
  abandoned: string[];
  expired: string[];
  deleted: string[];
  deleteFailures: string[];
  dispatched: string[];
}

export async function sweepEnvironmentSnapshots(
  deps: EnvironmentSnapshotSweepDeps,
): Promise<EnvironmentSnapshotSweepResult> {
  const log = deps.log ?? (() => {});
  const timeoutMs = deps.buildingTimeoutMs ?? DEFAULT_BUILDING_TIMEOUT_MS;
  const abandoned = await failAbandonedSnapshotBuilds(deps.pool, timeoutMs);

  const expired = await expireReadySnapshots(deps.pool, deps.keep ?? KEEP_READY_SNAPSHOTS);

  const deleted: string[] = [];
  const deleteFailures: string[] = [];
  const stale = await selectStaleProviderSnapshots(deps.pool);
  for (const row of stale) {
    const provider = deps.providers[row.sandbox_provider];
    if (!provider?.deleteSnapshot) continue;
    try {
      await provider.deleteSnapshot(row.provider_snapshot_id);
      await clearProviderSnapshotId(deps.pool, row.id);
      deleted.push(row.id);
    } catch (err) {
      deleteFailures.push(row.id);
      log("environment snapshot delete failed", { snapshotId: row.id, reason: err instanceof Error ? err.name : "unknown" });
    }
  }

  const dispatched: string[] = [];
  if (deps.startBuild) {
    for (const request of await claimSnapshotRequests(deps.pool, deps.dispatchLimit ?? 5)) {
      try {
        await deps.startBuild(request.organizationId, request.repositoryId);
        dispatched.push(`${request.organizationId}/${request.repositoryId}`);
      } catch (err) {
        await requestSnapshotBuild(deps.pool, request);
        log("environment snapshot build could not be started", {
          repositoryId: request.repositoryId,
          reason: err instanceof Error ? err.name : "unknown",
        });
      }
    }
  }

  return {
    abandoned,
    expired,
    deleted,
    deleteFailures,
    dispatched,
  };
}

export async function sweepEnvironmentSnapshotsLocked(
  deps: EnvironmentSnapshotSweepDeps,
): Promise<LockOutcome<EnvironmentSnapshotSweepResult>> {
  return withSweepLock(deps.pool, ENVIRONMENT_SNAPSHOT_SWEEP, () => sweepEnvironmentSnapshots(deps));
}
