

import type { Pool } from "pg";
import type { RepairPacket } from "@windkeel/verification/engine/repair.js";
import type { IncompleteStage } from "@windkeel/verification/evidence/incomplete.js";
import type { Verdict } from "@windkeel/verification/evidence/format.js";
import type { StopReason } from "./rails.js";
import type { KeySource } from "./model-policy.js";
import {
  getEngineeringRun,
  getEngineeringTask,
  listPendingSignals,
  listAgentRuns,
  listRepairAttempts,
  listVerificationRuns,
  type AgentRun,
  type EngineeringRun,
  type EngineeringTask,
  type RepairAttempt,
  type VerificationRun,
} from "./repositories.js";
import { REPAIR_ATTEMPT_CAPS } from "./rails.js";
import { selectRunCostTotals, selectRunModelCostBySource } from "./stores/cost-store.js";
import { selectWorkspaceEnvironmentRows } from "./stores/workspace-store.js";
import { listRunKnowledge } from "./knowledge.js";
import { describePlaybookVerifier, effectiveCriteria } from "./playbooks.js";
import { TERMINAL_STATES } from "./run-state-machine.js";
import { evidenceItemsOf, stageResults, type StageResultRecord } from "./stage-results.js";

export interface ReportedVerification {
  id: string;
  cycle: number;
  candidateSha: string;
  verdict: Verdict | null;
  startedAt: Date | null;
  completedAt: Date | null;

  evidence: { state: "stored" | "pruned" | "none"; ref: string | null; manifestDigest: string | null };

  verdictOfRecord: boolean;

  superseded: boolean;
  riskSummary: unknown;

  stages: StageResultRecord[] | null;
}

export interface ReportedRepairAttempt {
  attemptNumber: number;
  triggeringVerificationId: string;
  agentRunId: string | null;

  taken: boolean;
  failedCriteria: string[];
  failedChecks: string[];
  blockingFindings: string[];
  result: unknown;
}

export interface ReportedAgentRun {
  id: string;
  role: AgentRun["role"];
  workerType: string;
  model: string;
  startedAt: Date | null;
  completedAt: Date | null;
  tokenUsage: unknown;
  modelCostUsd: number | null;
  candidateSha: string | null;

  cachedInputShare: number | null;
}

export interface ReportedSourceCost {
  keySource: KeySource | null;

  usd: number;
  calls: number;
  unpricedCalls: number;
  tokensIn: number | null;
  tokensOut: number | null;
}

export interface ReportedCost {
  totalUsd: number;
  modelUsd: number;
  sandboxUsd: number;

  unpricedModelCalls: number;

  modelBySource: ReportedSourceCost[];

  runCostUsd: number;
  reconciles: boolean;
  spendCapUsd: number | null;
}

export interface ReportedPlaybook {
  slug: string;
  version: number;
  builtin: boolean;

  criteria: Array<{ id: string; text: string }>;

  verifierAdds: string[];
}

export interface RunReport {
  engineeringRunId: string;
  playbook: ReportedPlaybook | null;
  task: {
    id: string;
    title: string;
    riskLevel: EngineeringTask["riskLevel"];
    criteria: Array<{ id: string; text: string }>;

    criteriaProvenance: EngineeringTask["criteriaProvenance"];
    criteriaGeneratedBy: string | null;
    criteriaApprovedBy: string | null;
    criteriaApprovedAt: Date | null;
  };
  state: EngineeringRun["status"];
  terminal: boolean;
  stopReason: StopReason | null;
  stopReasonText: string | null;
  finalVerdict: Verdict | null;
  startedAt: Date | null;
  completedAt: Date | null;
  verifications: ReportedVerification[];
  repairAttempts: ReportedRepairAttempt[];

  repairAttemptsTaken: number;
  repairCap: number;
  agentRuns: ReportedAgentRun[];
  cost: ReportedCost;

  criteria: { satisfied: number | null; total: number };
  residualRisk: ResidualRisk;

  incompleteStages: IncompleteStage[];

  signed: boolean | null;

  pendingSignals: { kind: string; receivedAt: Date }[];

  environments?: ReportedEnvironment[];

  knowledge: ReportedKnowledge[];
}

export interface ReportedEnvironment {
  workspaceId: string;
  role: "maker" | "verifier";
  mode: "snapshot" | "cold";
  snapshotId: string | null;
  snapshotKey: string | null;
}

export interface ReportedKnowledge {
  noteId: string | null;
  noteVersion: number | null;
  sourceKind: string;
  title: string;
  provenance: string;
  chars: number;
}

export interface ResidualRisk {
  scored: false;
  reason: string;
  nonBlockingFindings: number | null;
  unsatisfiedCriteria: number | null;
}

const STOP_REASON_TEXT: Record<StopReason, string> = {
  spend_cap: "the run reached its spend cap",
  wall_clock_cap: "the run reached its wall-clock cap of working time (parked time does not count)",
  stuck: "consecutive repair attempts demanded the same fixes — the repairer stopped making progress",
  repair_cap: "the repair attempts allowed for this task's risk level were used up",
  approval_expired:
    "the generated acceptance criteria went unapproved until the approval gate closed — " +
    "nobody said yes, and nothing was spent waiting",
  error: "the run could not continue",
  model_policy:
    "the run's models could not be used — a credential was revoked or invalid, or the checker " +
    "was not independent of the maker — so nothing was provisioned",
  org_budget:
    "the organization's monthly budget was spent, so no further maker turn was started — any " +
    "candidate already produced was verified first, and nothing went out unverified",
};

interface RiskSummaryShape {
  blocking?: unknown;
  unsatisfied?: unknown;
  nonBlocking?: unknown;
  satisfied?: unknown;
  incomplete?: unknown;
  signed?: unknown;
}

function countOf(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number") return value;
  return null;
}

function incompleteOf(value: unknown): IncompleteStage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { stage, evidenceId, tool, detail, killed } = entry as Record<string, unknown>;
    if (typeof tool !== "string" || typeof detail !== "string") return [];
    return [
      {
        stage: (typeof stage === "string" ? stage : "checks") as IncompleteStage["stage"],
        evidenceId: typeof evidenceId === "string" ? evidenceId : "—",
        tool,
        detail,
        killed: killed === true,
      },
    ];
  });
}

export async function assembleRunReport(pool: Pool, engineeringRunId: string): Promise<RunReport> {
  const run = await getEngineeringRun(pool, engineeringRunId);
  if (!run) throw new Error(`no engineering_run ${engineeringRunId}`);
  const task = await getEngineeringTask(pool, run.taskId);
  if (!task) throw new Error(`engineering_task for run ${engineeringRunId} not found`);

  const verificationRows = await listVerificationRuns(pool, engineeringRunId);
  const attemptRows = await listRepairAttempts(pool, engineeringRunId);
  const agentRows = await listAgentRuns(pool, engineeringRunId);

  const completed = verificationRows.filter((v) => v.completedAt !== null);
  const lastCompleted = completed[completed.length - 1];

  const verifications = verificationRows.map((row, index) =>
    reportVerification(row, index, lastCompleted, completed),
  );
  const repairAttempts = attemptRows.map(reportAttempt);
  const agentRuns = agentRows.map(reportAgentRun);

  const cost = await reportCost(pool, run);
  const finalRisk: RiskSummaryShape | null = lastCompleted?.riskSummary ?? null;
  const environments = await reportEnvironments(pool, engineeringRunId);

  const criteria = effectiveCriteria(task);
  return {
    engineeringRunId,
    playbook: task.playbook
      ? {
          slug: task.playbook.slug,
          version: task.playbook.version,
          builtin: task.playbook.builtin,
          criteria: criteria.filter((c) => !task.acceptanceCriteria.includes(c)).map((c) => ({ id: c.id, text: c.text })),
          verifierAdds: describePlaybookVerifier(task.playbook.verifier),
        }
      : null,
    task: {
      id: task.id,
      title: task.title,
      riskLevel: task.riskLevel,
      criteria: criteria.map((c) => ({ id: c.id, text: c.text })),
      criteriaProvenance: task.criteriaProvenance,
      criteriaGeneratedBy: task.criteriaGeneratedBy,
      criteriaApprovedBy: task.criteriaApprovedBy,
      criteriaApprovedAt: task.criteriaApprovedAt,
    },
    state: run.status,
    terminal: TERMINAL_STATES.has(run.status),
    stopReason: run.stopReason,
    stopReasonText: run.stopReason ? STOP_REASON_TEXT[run.stopReason] : null,
    finalVerdict: run.finalVerdict,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    verifications,
    repairAttempts,
    repairAttemptsTaken: repairAttempts.filter((a) => a.taken).length,
    repairCap: REPAIR_ATTEMPT_CAPS[task.riskLevel],
    agentRuns,
    cost,
    criteria: {
      satisfied: countOf(finalRisk?.satisfied),
      total: criteria.length,
    },
    residualRisk: {
      scored: false,
      reason:
        "not scored: the risk engine is the planner milestone's. What is known is below, from the verdict of record.",
      nonBlockingFindings: countOf(finalRisk?.nonBlocking),
      unsatisfiedCriteria: countOf(finalRisk?.unsatisfied),
    },
    incompleteStages: incompleteOf(finalRisk?.incomplete),
    signed: typeof finalRisk?.signed === "boolean" ? finalRisk.signed : null,
    pendingSignals: (await listPendingSignals(pool, engineeringRunId)).map(({ kind, receivedAt }) => ({
      kind,
      receivedAt,
    })),
    ...(environments.length ? { environments } : {}),
    knowledge: (await listRunKnowledge(pool, engineeringRunId)).map((entry) => ({
      noteId: entry.noteId,
      noteVersion: entry.noteVersion,
      sourceKind: entry.sourceKind,
      title: entry.title,
      provenance: entry.provenance,
      chars: entry.chars,
    })),
  };
}

function knowledgeLines(report: Pick<RunReport, "knowledge">, row: (label: string, value: string) => string): string[] {
  const entries = report.knowledge ?? [];
  if (entries.length === 0) return [];
  const notes = entries.filter((e) => e.noteId !== null);
  const ids = notes.map((e) => `${e.noteId!.slice(0, 8)}@v${e.noteVersion ?? "?"}`).join(", ");
  const digest = entries.some((e) => e.sourceKind === "digest") ? " + codebase digest" : "";
  return [row("Knowledge injected", `${notes.length} note(s)${ids ? ` (${ids})` : ""}${digest}`)];
}

function reportVerification(
  row: VerificationRun,
  index: number,
  lastCompleted: VerificationRun | undefined,
  completed: VerificationRun[],
): ReportedVerification {
  const laterCompleted = completed.some(
    (other) =>
      other.id !== row.id &&
      other.completedAt !== null &&
      row.completedAt !== null &&
      other.completedAt > row.completedAt,
  );
  return {
    id: row.id,
    cycle: index + 1,
    candidateSha: row.candidateSha,
    verdict: row.verdict,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    evidence: {
      state: row.evidencePackageRef ? "stored" : row.evidencePrunedAt ? "pruned" : "none",
      ref: row.evidencePackageRef,
      manifestDigest: row.evidenceManifestDigest,
    },
    verdictOfRecord: lastCompleted?.id === row.id,
    superseded: laterCompleted,
    riskSummary: row.riskSummary,
    stages: stagesOf(row.riskSummary),
  };
}

function stagesOf(riskSummary: unknown): StageResultRecord[] | null {
  const items = evidenceItemsOf(riskSummary);
  return items === null ? null : stageResults(items);
}

function reportAttempt(row: RepairAttempt): ReportedRepairAttempt {
  const packet: RepairPacket = row.repairPacket;
  return {
    attemptNumber: row.attemptNumber,
    triggeringVerificationId: row.verificationRunId,
    agentRunId: row.agentRunId,
    taken: row.agentRunId !== null,
    failedCriteria: packet.failed_acceptance_criteria.map((c) => c.id),
    failedChecks: packet.failed_checks.map((c) => c.check),
    blockingFindings: [
      ...packet.security_findings,
      ...packet.review_findings,
      ...packet.browser_findings,
    ].map((f) => f.id),
    result: row.result,
  };
}

function cachedShareOf(usage: unknown): number | null {
  const u = usage as { inputTokens?: number; cachedInputTokens?: number } | null;
  if (!u || typeof u.inputTokens !== "number" || u.inputTokens <= 0) return null;
  if (typeof u.cachedInputTokens !== "number") return null;
  return Math.min(u.cachedInputTokens, u.inputTokens) / u.inputTokens;
}

function reportAgentRun(row: AgentRun): ReportedAgentRun {
  const result = row.result as { candidate?: { candidateSha?: string | null } } | null;
  return {
    id: row.id,
    role: row.role,
    workerType: row.workerType,
    model: row.model,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    tokenUsage: row.tokenUsage,
    modelCostUsd: row.modelCost,
    candidateSha: result?.candidate?.candidateSha ?? null,
    cachedInputShare: cachedShareOf(row.tokenUsage),
  };
}

async function reportEnvironments(pool: Pool, engineeringRunId: string): Promise<ReportedEnvironment[]> {
  const rows = await selectWorkspaceEnvironmentRows(pool, engineeringRunId);
  return rows.map((row) => ({
    workspaceId: row.id as string,
    role: row.role as "maker" | "verifier",
    mode: row.environment_mode as "snapshot" | "cold",
    snapshotId: (row.environment_snapshot_id as string | null) ?? null,
    snapshotKey: (row.cache_key as string | null) ?? null,
  }));
}

function environmentLines(
  report: Pick<RunReport, "environments">,
  row: (label: string, value: string) => string,
): string[] {
  if (!report.environments?.length) return [];
  const describe = (e: ReportedEnvironment) =>
    `${e.role} ${e.mode === "snapshot" ? `warm (snapshot ${(e.snapshotId ?? "").slice(0, 8)})` : "cold"}`;
  return [row("Environment", report.environments.map(describe).join(", "))];
}

async function reportCost(pool: Pool, run: EngineeringRun): Promise<ReportedCost> {
  const totals = await selectRunCostTotals(pool, run.id);
  const bySource = await selectRunModelCostBySource(pool, run.id);
  const totalUsd = Number(totals["total"]);
  return {
    totalUsd,
    modelUsd: Number(totals["model"]),
    sandboxUsd: Number(totals["sandbox"]),
    runCostUsd: run.cost,
    reconciles: Math.abs(totalUsd - run.cost) < 1e-9,
    spendCapUsd: run.spendCapUsd,

    unpricedModelCalls: Number(totals["unpriced"]),
    modelBySource: bySource.map((row) => ({
      keySource: (row.key_source as KeySource | null) ?? null,
      usd: Number(row.usd),
      calls: Number(row.calls),
      unpricedCalls: Number(row.unpriced),
      tokensIn: row.tokens_in === null ? null : Number(row.tokens_in),
      tokensOut: row.tokens_out === null ? null : Number(row.tokens_out),
    })),
  };
}

export function keySourceLabel(source: KeySource | null): string {
  return source === "orqon" ? "Windkeel's key" : source === "customer" ? "organization's key" : "not recorded";
}

function sourceLines(cost: ReportedCost): string[] {
  const sources = cost.modelBySource ?? [];
  if (sources.length === 0 || (sources.length === 1 && sources[0]!.keySource === "orqon")) return [];
  return sources.map(
    (source) =>
      `    ${keySourceLabel(source.keySource).padEnd(20)} $${source.usd.toFixed(4)}` +
      (source.unpricedCalls ? `  (at least; ${source.unpricedCalls} unpriced)` : ""),
  );
}

function sourceSummary(cost: ReportedCost): string {
  if (sourceLines(cost).length === 0) return "";
  return ` (model: ${(cost.modelBySource ?? [])
    .map((source) => `${keySourceLabel(source.keySource)} $${source.usd.toFixed(4)}`)
    .join(", ")})`;
}

const PASS_FAIL = (verdict: Verdict | null): string =>
  verdict === null ? "—" : verdict.toUpperCase();

export function pendingSignalLines(
  report: RunReport,
  row: (label: string, value: string) => string,
  now: Date = new Date(),
): string[] {
  const pending = report.pendingSignals ?? [];
  if (!pending.length) return [];
  const age = (at: Date) => {
    const minutes = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
  };
  return [
    row(
      "Signals not yet consumed",
      `${pending.length} — ${pending.map((s) => `${s.kind} ${age(s.receivedAt)}`).join(", ")}`,
    ),
  ];
}

export function signatureLines(
  report: RunReport,
  row: (label: string, value: string) => string,
): string[] {

  if (report.signed !== false) return [];
  return [
    row(
      "Evidence signature",
      "unsigned — the package is tamper-evident (the DSSE envelope covers every file) but " +
        "carries no provenance. Best-effort by policy, ADR-0022.",
    ),
  ];
}

export function incompleteLines(
  report: RunReport,
  row: (label: string, value: string) => string,
  clean: (text: string) => string = (text) => text,
): string[] {

  const stages = report.incompleteStages ?? [];
  if (!stages.length) return [];

  const killed = stages.filter((s) => s.killed).length;

  const because =
    report.finalVerdict === "warn" || report.finalVerdict === null
      ? " — this is why the verdict is not clean"
      : "";
  const summary =
    killed === stages.length
      ? `${stages.length} (all killed by a signal)${because}`
      : killed
        ? `${stages.length}, ${killed} killed by a signal${because}`
        : `${stages.length}${because}`;

  return [
    row("Stages not completed", summary),
    ...stages.map((s) => `  ${`${s.stage}/${s.evidenceId}`.padEnd(24)}${clean(s.detail)}`),
  ];
}

export function renderRunReport(report: RunReport): string {
  const lines: string[] = ["WINDKEEL RESULT", "", `Task: ${report.task.title}`, ""];

  const row = (label: string, value: string) => `${label.padEnd(26)}${value}`;
  const finalVerification = report.verifications.find((v) => v.verdictOfRecord);

  lines.push(
    row(
      "Acceptance criteria",
      report.criteria.satisfied === null
        ? `—/${report.criteria.total}`
        : `${report.criteria.satisfied}/${report.criteria.total}`,
    ),
    row("Verdict of record", PASS_FAIL(finalVerification?.verdict ?? null)),
    row("Repair attempts", `${report.repairAttemptsTaken}`),
    row("Residual risk", residualRiskLine(report.residualRisk)),
    row("Overall verdict", PASS_FAIL(report.finalVerdict)),
    "",
    row("Run state", `${report.state}${report.terminal ? " (terminal)" : ""}`),
  );

  lines.push(...incompleteLines(report, row));
  lines.push(...signatureLines(report, row));
  lines.push(...pendingSignalLines(report, row));
  lines.push(...environmentLines(report, row));
  lines.push(...knowledgeLines(report, row));
  if (report.playbook) lines.push(row("Playbook", playbookLine(report.playbook)));
  if (report.stopReason) {
    lines.push(row("Stopped because", `${report.stopReason} — ${report.stopReasonText}`));
  }
  lines.push(
    row(
      "Cost",
      `$${report.cost.totalUsd.toFixed(4)}${capText(report.cost.spendCapUsd)}` +
        (report.cost.unpricedModelCalls
          ? ` — at least; ${report.cost.unpricedModelCalls} model call(s) are unpriced`
          : "") +
        sourceSummary(report.cost),
    ),
    "",
  );

  lines.push("Verification cycles");
  if (report.verifications.length === 0) lines.push("  (none yet)");
  for (const verification of report.verifications) {
    lines.push(
      `  ${verification.cycle}. ${verification.candidateSha.slice(0, 12)}  ` +
        `${PASS_FAIL(verification.verdict)}${verification.verdictOfRecord ? "  [verdict of record]" : ""}` +
        `${verification.superseded ? "  [superseded]" : ""}`,
    );
    lines.push(`     evidence: ${evidenceLine(verification)}`);
  }
  lines.push("");

  lines.push("Repair history");
  if (report.repairAttempts.length === 0) lines.push("  (none)");
  for (const attempt of report.repairAttempts) {
    lines.push(
      `  attempt ${attempt.attemptNumber}${attempt.taken ? "" : " (not taken — the run stopped first)"}`,
    );
    lines.push(`     asked to fix: ${describeDemand(attempt)}`);
    if (attempt.agentRunId) lines.push(`     repairer: ${attempt.agentRunId}`);
  }
  lines.push("");

  lines.push("Agent and model provenance");
  if (report.agentRuns.length === 0) lines.push("  (none)");

  let previousCost: number | null = null;
  for (const agentRun of report.agentRuns) {
    const delta =
      agentRun.modelCostUsd !== null && previousCost !== null
        ? `  (+$${(agentRun.modelCostUsd - previousCost).toFixed(4)})`
        : "";
    const cached =
      agentRun.cachedInputShare === null
        ? ""
        : `  ${(agentRun.cachedInputShare * 100).toFixed(0)}% cached`;
    lines.push(
      `  ${agentRun.role.padEnd(20)}${agentRun.workerType}/${agentRun.model}` +
        `${agentRun.candidateSha ? `  candidate ${agentRun.candidateSha.slice(0, 12)}` : ""}` +
        `${agentRun.modelCostUsd === null ? "" : `  $${agentRun.modelCostUsd.toFixed(4)}${delta}`}` +
        cached,
    );
    if (agentRun.modelCostUsd !== null) previousCost = agentRun.modelCostUsd;
  }
  if (report.repairAttemptsTaken > 0) {
    lines.push(
      `  a repair resumes the maker's session, so each turn carries the ones before it —` +
        ` the cap counts attempts, not spend`,
    );
    lines.push(
      `  most of that carried prefix is served from cache and billed at a tenth of the rate;` +
        ` the per-turn share is above`,
    );
  }
  lines.push("");

  lines.push(
    "Cost",
    `  model    $${report.cost.modelUsd.toFixed(4)}`,
    ...sourceLines(report.cost),
    `  sandbox  $${report.cost.sandboxUsd.toFixed(4)}`,
    `  total    $${report.cost.totalUsd.toFixed(4)}${
      report.cost.unpricedModelCalls
        ? `  (a lower bound: ${report.cost.unpricedModelCalls} model call(s) reported tokens but no price)`
        : ""
    }`,
  );
  if (!report.cost.reconciles) {
    lines.push(
      `  WARNING: the ledger sums to $${report.cost.totalUsd.toFixed(4)} but the run row records ` +
        `$${report.cost.runCostUsd.toFixed(4)} — these are written in one transaction and must agree.`,
    );
  }

  return lines.join("\n");
}

function playbookLine(playbook: ReportedPlaybook): string {
  const adds = [
    ...(playbook.criteria.length ? [`${playbook.criteria.length} added criteria`] : []),
    ...playbook.verifierAdds,
  ];
  return `${playbook.slug} v${playbook.version}${playbook.builtin ? " (built-in)" : ""}${adds.length ? ` — also: ${adds.join("; ")}` : ""}`;
}

function residualRiskLine(risk: ResidualRisk): string {
  const known: string[] = [];
  if (risk.nonBlockingFindings !== null) known.push(`${risk.nonBlockingFindings} advisory finding(s)`);
  if (risk.unsatisfiedCriteria !== null) known.push(`${risk.unsatisfiedCriteria} unsatisfied criteria`);
  return `not scored (Milestone 10)${known.length ? ` — ${known.join(", ")}` : ""}`;
}

function capText(cap: number | null): string {
  return cap === null ? " of uncapped" : ` of $${cap}`;
}

function evidenceLine(verification: ReportedVerification): string {
  const digest = verification.evidence.manifestDigest
    ? ` (manifest ${verification.evidence.manifestDigest.slice(0, 12)})`
    : "";
  if (verification.evidence.state === "stored") return `${verification.evidence.ref}${digest}`;
  if (verification.evidence.state === "pruned") {
    return `pruned by policy (ADR-0015)${digest}`;
  }
  return "none sealed";
}

function describeDemand(attempt: ReportedRepairAttempt): string {
  const parts = [
    ...attempt.failedChecks.map((c) => `check ${c}`),
    ...attempt.failedCriteria.map((c) => `criterion ${c}`),
    ...attempt.blockingFindings.map((f) => `finding ${f}`),
  ];
  return parts.length ? parts.join(", ") : "(nothing recorded)";
}
