import type { EvidenceItem, Stage } from "./format.js";

export interface IncompleteStage {
  stage: Stage;
  evidenceId: string;
  tool: string;
  detail: string;
  killed: boolean;
}

export function incompleteStages(evidence: EvidenceItem[]): IncompleteStage[] {
  const incomplete: IncompleteStage[] = [];
  for (const item of evidence) {
    if (item.status !== "warning") continue;

    const unfinished = (item.scanners ?? []).filter((s) => !s.ran);
    if (unfinished.length) {
      for (const scanner of unfinished) {
        incomplete.push({
          stage: item.stage,
          evidenceId: item.id,
          tool: scanner.tool,
          detail: scanner.note,
          killed: scanner.killed === true,
        });
      }
      continue;
    }

    incomplete.push({
      stage: item.stage,
      evidenceId: item.id,
      tool: item.stage,
      detail: item.reason ?? item.summary ?? "did not complete, and said no more than that",
      killed: false,
    });
  }
  return incomplete;
}

export function describeIncomplete(stage: IncompleteStage): string {
  return `${stage.tool}: ${stage.detail} (${stage.evidenceId})`;
}
