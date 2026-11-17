
import type { Queryable } from "../../db/transaction.js";

export async function failAbandonedSnapshotBuilds(db: Queryable, timeoutMs: number): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `update environment_snapshot
        set status = 'failed',
            detail = 'the build was abandoned: nothing finished it within ' || $1::text || ' minutes'
      where status = 'building' and created_at < now() - ($2::bigint * interval '1 millisecond')
      returning id`,
    [String(Math.round(timeoutMs / 60_000)), String(timeoutMs)],
  );
  return rows.map((r) => r.id);
}

export async function expireReadySnapshots(db: Queryable, keep: number): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `update environment_snapshot set status = 'expired'
      where id in (
        select id from (
          select id, expires_at,
                 row_number() over (partition by organization_id, repository_id, sandbox_provider
                                    order by ready_at desc nulls last, created_at desc) as rank
            from environment_snapshot where status = 'ready') ranked
         where (expires_at is not null and expires_at <= now()) or rank > $1)
      returning id`,
    [keep],
  );
  return rows.map((r) => r.id);
}

export interface StaleProviderSnapshot {
  id: string;
  sandbox_provider: string;
  provider_snapshot_id: string;
}

export async function selectStaleProviderSnapshots(db: Queryable): Promise<StaleProviderSnapshot[]> {
  const { rows } = await db.query<StaleProviderSnapshot>(
    `select id, sandbox_provider, provider_snapshot_id from environment_snapshot
      where status in ('expired', 'invalidated') and provider_snapshot_id is not null
      order by created_at limit 50`,
  );
  return rows;
}

export async function clearProviderSnapshotId(db: Queryable, id: string): Promise<void> {
  await db.query(
    `update environment_snapshot set provider_snapshot_id = null
      where id = $1 and status in ('expired', 'invalidated')`,
    [id],
  );
}
