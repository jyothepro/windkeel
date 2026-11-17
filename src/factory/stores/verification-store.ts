
import type { Verdict } from "@windkeel/verification/evidence/format.js";
import type { RepairPacket } from "@windkeel/verification/engine/repair.js";
import type { Queryable } from "../db/transaction.js";

export interface VerificationRun {
  id: string;
  engineeringRunId: string;
  candidateSha: string;
  policyVersion: string;
  verdict: Verdict | null;
  evidencePackageRef: string | null;
  riskSummary: unknown;
  startedAt: Date | null;
  completedAt: Date | null;
  evidencePrunedAt: Date | null;
  evidenceManifestDigest: string | null;
}

export type NewVerificationRun = Pick<VerificationRun, "engineeringRunId" | "candidateSha" | "policyVersion">;

function rowToVerificationRun(row: Record<string, unknown>): VerificationRun {
  return {
    id: row.id as string,
    engineeringRunId: row.engineering_run_id as string,
    candidateSha: row.candidate_sha as string,
    policyVersion: row.policy_version as string,
    verdict: row.verdict as Verdict | null,
    evidencePackageRef: row.evidence_package_ref as string | null,
    riskSummary: row.risk_summary,
    startedAt: row.started_at as Date | null,
    completedAt: row.completed_at as Date | null,
    evidencePrunedAt: row.evidence_pruned_at as Date | null,
    evidenceManifestDigest: row.evidence_manifest_digest as string | null,
  };
}

export async function insertVerificationRun(
  db: Queryable,
  run: NewVerificationRun,
): Promise<VerificationRun> {
  const { rows } = await db.query(
    `insert into verification_run (engineering_run_id, candidate_sha, policy_version)
     values ($1, $2, $3)
     returning *`,
    [run.engineeringRunId, run.candidateSha, run.policyVersion],
  );
  return rowToVerificationRun(rows[0]);
}

export async function getVerificationRun(db: Queryable, id: string): Promise<VerificationRun | null> {
  const { rows } = await db.query("select * from verification_run where id = $1", [id]);
  return rows[0] ? rowToVerificationRun(rows[0]) : null;
}

export interface VerificationRunPatch {
  verdict?: Verdict | null;
  evidencePackageRef?: string | null;
  riskSummary?: unknown;
  startedAt?: Date | null;
  completedAt?: Date | null;
  evidencePrunedAt?: Date | null;
  evidenceManifestDigest?: string | null;
}

const VERIFICATION_RUN_PATCH_COLUMNS: Record<keyof VerificationRunPatch, string> = {
  verdict: "verdict",
  evidencePackageRef: "evidence_package_ref",
  riskSummary: "risk_summary",
  startedAt: "started_at",
  completedAt: "completed_at",
  evidencePrunedAt: "evidence_pruned_at",
  evidenceManifestDigest: "evidence_manifest_digest",
};

export async function updateVerificationRun(
  db: Queryable,
  id: string,
  patch: VerificationRunPatch,
): Promise<VerificationRun> {
  const entries = Object.entries(patch) as Array<[keyof VerificationRunPatch, unknown]>;
  if (entries.length === 0) {
    const current = await getVerificationRun(db, id);
    if (!current) throw new Error(`verification_run ${id} not found`);
    return current;
  }
  const setClauses = entries.map(([key], i) => `${VERIFICATION_RUN_PATCH_COLUMNS[key]} = $${i + 2}`);
  const values = entries.map(([key, value]) => (key === "riskSummary" ? JSON.stringify(value) : value));
  const { rows } = await db.query(
    `update verification_run set ${setClauses.join(", ")} where id = $1 returning *`,
    [id, ...values],
  );
  if (!rows[0]) throw new Error(`verification_run ${id} not found`);
  return rowToVerificationRun(rows[0]);
}

export async function listVerificationRuns(
  db: Queryable,
  engineeringRunId: string,
): Promise<VerificationRun[]> {
  const { rows } = await db.query(
    "select * from verification_run where engineering_run_id = $1 order by started_at nulls last, id",
    [engineeringRunId],
  );
  return rows.map(rowToVerificationRun);
}

export async function listPrunableVerificationRuns(
  db: Queryable,
  now: Date,
  retentionDays: number,
): Promise<VerificationRun[]> {
  const { rows } = await db.query(
    `select vr.* from verification_run vr
     where vr.evidence_package_ref is not null
       and vr.completed_at is not null
       and vr.completed_at <= $1::timestamptz - ($2 || ' days')::interval
       and exists (
         select 1 from verification_run later
         where later.engineering_run_id = vr.engineering_run_id
           and later.completed_at > vr.completed_at
       )
     order by vr.completed_at`,
    [now, retentionDays],
  );
  return rows.map(rowToVerificationRun);
}

export interface RepairAttempt {
  id: string;
  engineeringRunId: string;
  verificationRunId: string;
  agentRunId: string | null;
  attemptNumber: number;
  repairPacket: RepairPacket;
  result: unknown;
}

export type NewRepairAttempt = Omit<RepairAttempt, "id" | "agentRunId" | "result"> &
  Partial<Pick<RepairAttempt, "agentRunId">>;

function rowToRepairAttempt(row: Record<string, unknown>): RepairAttempt {
  return {
    id: row.id as string,
    engineeringRunId: row.engineering_run_id as string,
    verificationRunId: row.verification_run_id as string,
    agentRunId: row.agent_run_id as string | null,
    attemptNumber: row.attempt_number as number,
    repairPacket: row.repair_packet as RepairPacket,
    result: row.result,
  };
}

export async function insertRepairAttempt(
  db: Queryable,
  attempt: NewRepairAttempt,
): Promise<RepairAttempt> {
  const { rows } = await db.query(
    `insert into repair_attempt
       (engineering_run_id, verification_run_id, agent_run_id, attempt_number, repair_packet)
     values ($1, $2, $3, $4, $5)
     returning *`,
    [
      attempt.engineeringRunId,
      attempt.verificationRunId,
      attempt.agentRunId ?? null,
      attempt.attemptNumber,
      JSON.stringify(attempt.repairPacket),
    ],
  );
  return rowToRepairAttempt(rows[0]);
}

export interface RepairAttemptPatch {
  agentRunId?: string | null;
  result?: unknown;
}

const REPAIR_ATTEMPT_PATCH_COLUMNS: Record<keyof RepairAttemptPatch, string> = {
  agentRunId: "agent_run_id",
  result: "result",
};

export async function updateRepairAttempt(
  db: Queryable,
  id: string,
  patch: RepairAttemptPatch,
): Promise<RepairAttempt> {
  const entries = Object.entries(patch) as Array<[keyof RepairAttemptPatch, unknown]>;
  if (entries.length === 0) {
    const current = await getRepairAttempt(db, id);
    if (!current) throw new Error(`repair_attempt ${id} not found`);
    return current;
  }
  const setClauses = entries.map(([key], i) => `${REPAIR_ATTEMPT_PATCH_COLUMNS[key]} = $${i + 2}`);
  const values = entries.map(([key, value]) =>
    key === "result" ? JSON.stringify(value ?? null) : value,
  );
  const { rows } = await db.query(
    `update repair_attempt set ${setClauses.join(", ")} where id = $1 returning *`,
    [id, ...values],
  );
  if (!rows[0]) throw new Error(`repair_attempt ${id} not found`);
  return rowToRepairAttempt(rows[0]);
}

async function getRepairAttempt(db: Queryable, id: string): Promise<RepairAttempt | null> {
  const { rows } = await db.query("select * from repair_attempt where id = $1", [id]);
  return rows[0] ? rowToRepairAttempt(rows[0]) : null;
}

export async function listRepairAttempts(
  db: Queryable,
  engineeringRunId: string,
): Promise<RepairAttempt[]> {
  const { rows } = await db.query(
    "select * from repair_attempt where engineering_run_id = $1 order by attempt_number, id",
    [engineeringRunId],
  );
  return rows.map(rowToRepairAttempt);
}

export async function getRepairAttemptForVerification(
  db: Queryable,
  verificationRunId: string,
): Promise<RepairAttempt | null> {
  const { rows } = await db.query(
    "select * from repair_attempt where verification_run_id = $1 order by attempt_number limit 1",
    [verificationRunId],
  );
  return rows[0] ? rowToRepairAttempt(rows[0]) : null;
}

export async function listRepairPackets(
  db: Queryable,
  engineeringRunId: string,
): Promise<RepairPacket[]> {
  const { rows } = await db.query(
    "select repair_packet from repair_attempt where engineering_run_id = $1 order by attempt_number",
    [engineeringRunId],
  );
  return rows.map((r) => r.repair_packet as RepairPacket);
}
