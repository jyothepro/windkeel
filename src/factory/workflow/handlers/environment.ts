

import {
  findReadySnapshot,
  requestSnapshotBuild,
  type RestorableSnapshot,
} from "../../environment-snapshots.js";
import type { ProvisionedEnvironment } from "../../workspace-service.js";
import { resolveRepositoryContext } from "../repository-target.js";
import type { StageDeps } from "../stage-deps.js";
import { latestSnapshotStatus } from "../stores/workflow-misc-store.js";

export async function environmentFor(
  deps: StageDeps,
  engineeringRunId: string,
  role: "maker" | "verifier",
): Promise<{ snapshot?: RestorableSnapshot } | undefined> {
  const settings = deps.config.environmentSnapshots;
  if (!settings?.enabled) return undefined;

  if (role === "verifier" && !settings.forVerifier) return {};
  if (!deps.sandboxes.capabilities.snapshots) return {};
  const { repository, organizationId } = await resolveRepositoryContext(
    deps.pool,
    engineeringRunId,
    deps.config.repository,
  );
  if (!repository) return {};
  const found = await findReadySnapshot(deps.pool, organizationId, repository.id, deps.sandboxes.name);
  if (!found?.providerSnapshotId) return {};
  return {
    snapshot: {
      id: found.id,
      providerSnapshotId: found.providerSnapshotId,
      baseSha: found.baseSha,
      cacheKey: found.cacheKey,
      keyPaths: found.keyPaths,
    },
  };
}

export async function requestBuildAfter(
  deps: StageDeps,
  engineeringRunId: string,
  role: "maker" | "verifier",
  environment: ProvisionedEnvironment | undefined,
): Promise<void> {
  if (!environment || !deps.sandboxes.capabilities.snapshots) return;

  if (role === "verifier" && !deps.config.environmentSnapshots?.forVerifier) return;
  const stale =
    role === "maker" && environment.mode === "snapshot" && environment.installInputChanges !== undefined &&
    (environment.installInputChanges === null || environment.installInputChanges.length > 0);
  if (environment.mode !== "cold" && !stale) return;
  const { repository, organizationId } = await resolveRepositoryContext(
    deps.pool,
    engineeringRunId,
    deps.config.repository,
  );
  if (!repository) return;

  const latest = await latestSnapshotStatus(deps.pool, organizationId, repository.id, deps.sandboxes.name);
  if (latest?.status === "failed" && latest?.recent === true) return;
  await requestSnapshotBuild(deps.pool, {
    organizationId,
    repositoryId: repository.id,
    requestedBy: "system",
    reason: stale
      ? `run ${engineeringRunId}: the default branch's install inputs moved past snapshot ${environment.snapshotId}`
      : `run ${engineeringRunId}: the ${role} provisioned cold`,
  });
}
