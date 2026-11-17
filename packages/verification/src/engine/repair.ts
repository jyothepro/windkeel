import type { Criterion, EvidenceItem, Finding, MappingFile } from "../evidence/format.js";
import type { VerdictComputation } from "../evidence/verdict.js";
import { checkCouldNotRun } from "../stages/checks.js";

export interface RepairPacket {
  failed_acceptance_criteria: Array<{ id: string; text: string; reason: string }>;
  failed_checks: Array<{
    check: string;
    command?: string | undefined;
    exit_code?: number | undefined;
    transcript?: string | undefined;
  }>;
  checks_could_not_run: Array<{
    check: string;
    command?: string | undefined;
    exit_code?: number | undefined;
    detail: string;
    transcript?: string | undefined;
  }>;
  security_findings: Finding[];
  review_findings: Finding[];
  browser_findings: Finding[];
  evidence_links: string[];
  recommended_focus: string[];
  repair_constraints: string[];
}

const CONSTRAINTS = [
  "repair the implementation, not the verifier: do not edit, weaken, or remove repo checks, declared browser flows, or acceptance criteria to make them pass",
  "do not delete, skip, or hollow out failing tests; make the behavior they demand real",
  "stay within the scope of the original change; re-verification reviews the full diff",
];

const blockingIn = (evidence: EvidenceItem[], stage: EvidenceItem["stage"]): Finding[] =>
  evidence
    .filter((e) => e.stage === stage)
    .flatMap((e) => (e.findings ?? []).filter((f) => f.severity === "blocking"));

export function buildRepairPacket(
  evidence: EvidenceItem[],
  mapping: MappingFile,
  criteria: Criterion[],
  computation: VerdictComputation,
): RepairPacket | null {
  if (computation.verdict !== "fail") return null;

  const criterionText = new Map(criteria.map((c) => [c.id, c.text]));
  const failedCriteria = mapping.mappings
    .filter((m) => m.status === "unsatisfied")
    .map((m) => ({
      id: m.criterion,
      text: criterionText.get(m.criterion) ?? "",
      reason: m.reason,
    }));

  const failedCheckEvidence = evidence.filter((e) => e.stage === "checks" && e.status === "failed");

  const failedChecks = failedCheckEvidence
    .filter((e) => !checkCouldNotRun(e))
    .map((e) => ({
      check: e.type.replace(/_result$/, ""),
      command: e.producer?.command,
      exit_code: e.producer?.exit_code,
      transcript: e.transcript,
    }));

  const checksCouldNotRun = failedCheckEvidence.filter(checkCouldNotRun).map((e) => ({
    check: e.type.replace(/_result$/, ""),
    command: e.producer?.command,
    exit_code: e.producer?.exit_code,
    detail: e.summary ?? e.reason ?? "the check did not execute",
    transcript: e.transcript,
  }));

  const security = blockingIn(evidence, "security");
  const review = blockingIn(evidence, "review");
  const browser = blockingIn(evidence, "browser");

  const cited = evidence.filter(
    (e) =>
      (e.findings ?? []).some((f) => f.severity === "blocking") ||
      (e.stage === "checks" && e.status === "failed"),
  );
  const evidenceLinks = [
    ...cited.map((e) => `evidence/${e.id}.json`),
    ...cited.flatMap((e) => (e.transcript ? [e.transcript] : [])),
    "verdict.json",
    "mapping.json",
  ];

  const focus = [
    ...failedChecks.map(
      (c) => `make \`${c.check}\` exit 0${c.command ? ` (\`${c.command}\`)` : ""}${c.transcript ? ` — see ${c.transcript}` : ""}`,
    ),
    ...failedCriteria.map((c) => `demonstrate ${c.id}${c.text ? `: ${c.text}` : ""} — ${c.reason}`),
    ...security.map((f) => `resolve ${f.id}: ${f.claim}`),
    ...review.map((f) => `resolve ${f.id}: ${f.claim}${f.location ? ` (${f.location})` : ""}`),
    ...browser.map((f) => `resolve ${f.id}: ${f.claim}`),
  ];

  return {
    failed_acceptance_criteria: failedCriteria,
    failed_checks: failedChecks,
    checks_could_not_run: checksCouldNotRun,
    security_findings: security,
    review_findings: review,
    browser_findings: browser,
    evidence_links: [...new Set(evidenceLinks)],
    recommended_focus: focus,
    repair_constraints: CONSTRAINTS,
  };
}
