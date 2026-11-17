

import { SNAPSHOT_FORMAT_VERSION } from "../../sandbox/environment-snapshot.js";
import type { ProposedSetup } from "../setup-detection.js";
import type { Queryable } from "../db/transaction.js";

type Db = Queryable;

export type EnvironmentSnapshotStatus = "building" | "ready" | "failed" | "invalidated" | "expired";

export interface EnvironmentSnapshot {
  id: string;
  organizationId: string;
  repositoryId: string;
  sandboxProvider: string;
  formatVersion: number;
  cacheKey: string;
  keyPaths: string[];
  baseSha: string;
  providerSnapshotId: string | null;
  status: EnvironmentSnapshotStatus;

  detail: string | null;
  setupLogRef: string | null;
  sizeBytes: number | null;
  builtBy: string;

  proposedSetup: ProposedSetup | null;
  createdAt: Date;
  readyAt: Date | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
}

export interface RestorableSnapshot {
  id: string;
  providerSnapshotId: string;
  baseSha: string;
  cacheKey: string;
  keyPaths: string[];
}

export const DEFAULT_SNAPSHOT_TTL_DAYS = 14;

export const KEEP_READY_SNAPSHOTS = 2;

function rowToSnapshot(row: Record<string, unknown>): EnvironmentSnapshot {
  return {
    id: row["id"] as string,
    organizationId: row["organization_id"] as string,
    repositoryId: row["repository_id"] as string,
    sandboxProvider: row["sandbox_provider"] as string,
    formatVersion: Number(row["format_version"]),
    cacheKey: row["cache_key"] as string,
    keyPaths: (row["key_paths"] as string[] | null) ?? [],
    baseSha: row["base_sha"] as string,
    providerSnapshotId: (row["provider_snapshot_id"] as string | null) ?? null,
    status: row["status"] as EnvironmentSnapshotStatus,
    detail: (row["detail"] as string | null) ?? null,
    setupLogRef: (row["setup_log_ref"] as string | null) ?? null,
    sizeBytes: row["size_bytes"] === null || row["size_bytes"] === undefined ? null : Number(row["size_bytes"]),
    builtBy: row["built_by"] as string,
    proposedSetup: (row["proposed_setup"] as ProposedSetup | null) ?? null,
    createdAt: row["created_at"] as Date,
    readyAt: (row["ready_at"] as Date | null) ?? null,
    expiresAt: (row["expires_at"] as Date | null) ?? null,
    lastUsedAt: (row["last_used_at"] as Date | null) ?? null,
  };
}

export interface SnapshotClaim {
  organizationId: string;
  repositoryId: string;
  sandboxProvider: string;
  cacheKey: string;
  keyPaths: readonly string[];
  baseSha: string;
  builtBy: string;
  formatVersion?: number;
}

export async function claimSnapshotBuild(db: Db, claim: SnapshotClaim): Promise<EnvironmentSnapshot | null> {
  const { rows } = await db.query(
    `insert into environment_snapshot
       (organization_id, repository_id, sandbox_provider, format_version, cache_key, key_paths,
        base_sha, status, built_by)
     values ($1, $2, $3, $4, $5, $6, $7, 'building', $8)
     on conflict (organization_id, repository_id, sandbox_provider, cache_key)
       where status in ('building', 'ready') do nothing
     returning *`,
    [
      claim.organizationId,
      claim.repositoryId,
      claim.sandboxProvider,
      claim.formatVersion ?? SNAPSHOT_FORMAT_VERSION,
      claim.cacheKey,
      [...claim.keyPaths],
      claim.baseSha,
      claim.builtBy,
    ],
  );
  return rows[0] ? rowToSnapshot(rows[0]) : null;
}

export async function markSnapshotReady(
  db: Db,
  id: string,
  ready: { providerSnapshotId: string; sizeBytes?: number | undefined; detail: string; ttlDays: number },
): Promise<EnvironmentSnapshot | null> {
  const { rows } = await db.query(
    `update environment_snapshot
        set status = 'ready', provider_snapshot_id = $2, size_bytes = $3, detail = $4,
            ready_at = now(), expires_at = now() + ($5::double precision * interval '1 day')
      where id = $1 and status = 'building'
      returning *`,
    [id, ready.providerSnapshotId, ready.sizeBytes ?? null, ready.detail, ready.ttlDays],
  );
  return rows[0] ? rowToSnapshot(rows[0]) : null;
}

export async function markSnapshotFailed(db: Db, id: string, detail: string): Promise<void> {
  await db.query(
    `update environment_snapshot set status = 'failed', detail = $2
      where id = $1 and status = 'building'`,
    [id, detail.slice(0, 4000)],
  );
}

export async function findReadySnapshot(
  db: Db,
  organizationId: string,
  repositoryId: string,
  sandboxProvider: string,
  cacheKey?: string,
): Promise<EnvironmentSnapshot | null> {
  const { rows } = await db.query(
    `select * from environment_snapshot
      where organization_id = $1 and repository_id = $2 and sandbox_provider = $3
        and status = 'ready' and provider_snapshot_id is not null
        and format_version = $4
        and (expires_at is null or expires_at > now())
        and ($5::text is null or cache_key = $5)
      order by ready_at desc nulls last, created_at desc
      limit 1`,
    [organizationId, repositoryId, sandboxProvider, SNAPSHOT_FORMAT_VERSION, cacheKey ?? null],
  );
  return rows[0] ? rowToSnapshot(rows[0]) : null;
}

export async function touchSnapshot(db: Db, id: string): Promise<void> {
  await db.query("update environment_snapshot set last_used_at = now() where id = $1", [id]);
}

export async function invalidateSnapshots(
  db: Db,
  repositoryId: string,
  reason: string,
  organizationId?: string,
): Promise<number> {
  const { rowCount } = await db.query(
    `update environment_snapshot set status = 'invalidated', detail = $2
      where repository_id = $1 and status in ('building', 'ready')
        and ($3::uuid is null or organization_id = $3)`,
    [repositoryId, `invalidated: ${reason}`.slice(0, 4000), organizationId ?? null],
  );
  return rowCount ?? 0;
}

export async function listSnapshots(
  db: Db,
  organizationId: string,
  repositoryId: string,
  limit = 20,
): Promise<EnvironmentSnapshot[]> {
  const { rows } = await db.query(
    `select * from environment_snapshot where organization_id = $1 and repository_id = $2
      order by created_at desc limit $3`,
    [organizationId, repositoryId, limit],
  );
  return rows.map(rowToSnapshot);
}

export async function recordWorkspaceEnvironment(
  db: Db,
  workspaceId: string,
  mode: "snapshot" | "cold",
  snapshotId: string | null,
): Promise<void> {
  await db.query(
    "update workspace set environment_mode = $2, environment_snapshot_id = $3 where id = $1",
    [workspaceId, mode, snapshotId],
  );
}

export interface BuildRequest {
  organizationId: string;
  repositoryId: string;
  requestedBy: string;
  reason: string;
}

export async function requestSnapshotBuild(db: Db, request: BuildRequest): Promise<void> {
  await db.query(
    `insert into environment_snapshot_request (organization_id, repository_id, requested_by, reason)
     values ($1, $2, $3, $4)
     on conflict (organization_id, repository_id) do update
       set requested_by = excluded.requested_by, reason = excluded.reason`,
    [request.organizationId, request.repositoryId, request.requestedBy, request.reason.slice(0, 500)],
  );
}

export async function pendingSnapshotRequest(
  db: Db,
  organizationId: string,
  repositoryId: string,
): Promise<{ requestedBy: string; reason: string; requestedAt: Date } | null> {
  const { rows } = await db.query(
    `select requested_by, reason, requested_at from environment_snapshot_request
      where organization_id = $1 and repository_id = $2`,
    [organizationId, repositoryId],
  );
  const row = rows[0];
  return row
    ? { requestedBy: row["requested_by"] as string, reason: row["reason"] as string, requestedAt: row["requested_at"] as Date }
    : null;
}

export async function claimSnapshotRequests(db: Db, limit: number): Promise<BuildRequest[]> {
  const { rows } = await db.query(
    `delete from environment_snapshot_request
      where (organization_id, repository_id) in (
        select organization_id, repository_id from environment_snapshot_request
         order by requested_at limit $1 for update skip locked)
      returning organization_id, repository_id, requested_by, reason`,
    [limit],
  );
  return rows.map((row) => ({
    organizationId: row["organization_id"] as string,
    repositoryId: row["repository_id"] as string,
    requestedBy: row["requested_by"] as string,
    reason: row["reason"] as string,
  }));
}

export async function setSnapshotProposedSetup(db: Db, id: string, proposal: string): Promise<void> {
  await db.query("update environment_snapshot set proposed_setup = $2 where id = $1", [id, proposal]);
}
