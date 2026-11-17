
import type { Queryable } from "../db/transaction.js";

type Row = Record<string, unknown>;

export interface RunMergeInsert {
  engineeringRunId: string;
  organizationId: string;
  principalId: string;
  repositoryId: string;
  prNumber: number;
  verifiedSha: string;
  verificationRunId: string;
  verdict: string;
  verdictDigest: string | null;

  acknowledgements: string;
  markReady: boolean;
  mergeMethod: string;
}

export async function insertRunMergeRow(db: Queryable, v: RunMergeInsert): Promise<Row> {
  const { rows } = await db.query(
    `insert into run_merge
       (engineering_run_id, organization_id, principal_id, repository_id, pr_number, verified_sha,
        verification_run_id, verdict, verdict_digest, acknowledgements, mark_ready, merge_method)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     returning *`,
    [
      v.engineeringRunId,
      v.organizationId,
      v.principalId,
      v.repositoryId,
      v.prNumber,
      v.verifiedSha,
      v.verificationRunId,
      v.verdict,
      v.verdictDigest,
      v.acknowledgements,
      v.markReady,
      v.mergeMethod,
    ],
  );
  return rows[0]!;
}

export async function selectRunMergeRow(db: Queryable, id: string): Promise<Row | undefined> {
  const { rows } = await db.query("select * from run_merge where id = $1", [id]);
  return rows[0];
}

export async function selectLatestRunMergeRow(db: Queryable, engineeringRunId: string): Promise<Row | undefined> {
  const { rows } = await db.query(
    "select * from run_merge where engineering_run_id = $1 order by created_at desc, id desc limit 1",
    [engineeringRunId],
  );
  return rows[0];
}

export async function settleRunMergeRow(
  db: Queryable,
  id: string,
  v: { status: string; reason: string | null; mergedSha: string | null; githubLogin: string | null },
): Promise<Row | undefined> {
  const { rows } = await db.query(
    `update run_merge set status = $2, reason = $3, merged_sha = $4, github_login = coalesce($5, github_login),
            completed_at = now()
      where id = $1 and status = 'pending'
      returning *`,
    [id, v.status, v.reason, v.mergedSha, v.githubLogin],
  );
  return rows[0];
}

export async function heartbeatRunMergeRow(db: Queryable, id: string, mergeSent: boolean): Promise<number | null> {
  const { rowCount } = await db.query(
    `update run_merge set heartbeat_at = now(), merge_sent_at = case when $2 then now() else merge_sent_at end
      where id = $1 and status = 'pending'`,
    [id, mergeSent],
  );
  return rowCount;
}

export async function updateOrganizationAllowMerge(db: Queryable, organizationId: string, allow: boolean): Promise<unknown> {
  const { rows } = await db.query("update organization set allow_merge = $2 where id = $1 returning allow_merge", [organizationId, allow]);
  return rows[0]?.["allow_merge"];
}

export async function selectOrganizationAllowMerge(db: Queryable, organizationId: string): Promise<unknown> {
  const { rows } = await db.query("select allow_merge from organization where id = $1", [organizationId]);
  return rows[0]?.["allow_merge"];
}
