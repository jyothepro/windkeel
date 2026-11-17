import {
  VERDICT_RULE,
  type EvidenceItem,
  type MappingFile,
  type Verdict,
  type VerdictFile,
} from "./format.js";

export interface VerdictComputation {
  verdict: Verdict;
  blocking: string[];
  nonBlocking: string[];
  unsatisfied: string[];
  satisfied: string[];
  unknown: string[];
  counts: Record<string, number>;
}

export function computeVerdict(
  evidence: EvidenceItem[],
  mapping: MappingFile,
): VerdictComputation {
  const findings = evidence.flatMap((e) => e.findings ?? []);
  const blocking = findings.filter((f) => f.severity === "blocking").map((f) => f.id);
  const nonBlocking = findings.filter((f) => f.severity === "non_blocking").map((f) => f.id);
  const unsatisfied = mapping.mappings
    .filter((m) => m.status === "unsatisfied")
    .map((m) => m.criterion);
  const satisfied = mapping.mappings
    .filter((m) => m.status === "satisfied")
    .map((m) => m.criterion);
  const unknown = mapping.mappings.filter((m) => m.status === "unknown").map((m) => m.criterion);
  const warnings = evidence.filter((e) => e.status === "warning");

  const counts: Record<string, number> = {};
  for (const e of evidence) counts[e.status] = (counts[e.status] ?? 0) + 1;

  const verdict: Verdict =
    blocking.length || unsatisfied.length
      ? "fail"
      : warnings.length || nonBlocking.length || unknown.length
        ? "warn"
        : "pass";

  return { verdict, blocking, nonBlocking, unsatisfied, satisfied, unknown, counts };
}

export function verdictFile(c: VerdictComputation, summary: string): VerdictFile {
  return {
    verdict: c.verdict,
    rule: VERDICT_RULE,
    blocking_findings: c.blocking,
    unsatisfied_criteria: c.unsatisfied,
    unknown_criteria: c.unknown,
    criteria: {
      satisfied: c.satisfied.length,
      unsatisfied: c.unsatisfied.length,
      unknown: c.unknown.length,
      total: c.satisfied.length + c.unsatisfied.length + c.unknown.length,
    },
    evidence_counts: c.counts,
    summary,
  };
}
