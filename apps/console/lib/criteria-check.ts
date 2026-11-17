import type { Dot, RunState } from "./run-states.ts";
import { dotForStage } from "./run-states.ts";
import type { Criterion, EvidenceStatus, ReportedVerification } from "./types.ts";

export type CriterionMark = "met" | "not_met" | "unsettled" | "not_itemised" | "not_checked";

export const CRITERION_MARK_LABEL: Record<CriterionMark, string> = {
  met: "met",
  not_met: "not met",
  unsettled: "couldn't be settled",
  not_itemised: "see the evidence",
  not_checked: "not checked yet",
};

export interface CriteriaCheck {
  headline: string;
  detail: string | null;
  dot: Dot | null;
  verificationId: string | null;
  cycle: number | null;
  items: Array<{ id: string; text: string; mark: CriterionMark }>;
}

const MARK_OF: Record<EvidenceStatus, CriterionMark> = {
  passed: "met",
  failed: "not_met",
  warning: "unsettled",
  completed_with_findings: "unsettled",
  skipped: "not_checked",
};

export function newestVerification(verifications: readonly ReportedVerification[]): ReportedVerification | null {
  let newest: ReportedVerification | null = null;
  for (const v of verifications) if (!newest || v.cycle >= newest.cycle) newest = v;
  return newest;
}

export function criteriaCheck(criteria: readonly Criterion[], verifications: readonly ReportedVerification[], state: RunState): CriteriaCheck {
  const all = (mark: CriterionMark) => criteria.map((c) => ({ id: c.id, text: c.text, mark }));
  const v = newestVerification(verifications);
  if (!v) {
    return {
      headline: "Not checked yet",
      detail:
        state === "WAITING_FOR_APPROVAL"
          ? "Once you approve them, Windkeel makes the change and an independent verifier checks it against each of these."
          : "An independent verifier checks the change against each of these once Windkeel has made it.",
      dot: null,
      verificationId: null,
      cycle: null,
      items: all("not_checked"),
    };
  }
  const from = { verificationId: v.id, cycle: v.cycle };
  if (!v.stages) {
    const running = v.verdict === null && v.completedAt === null;
    return {
      headline: running ? "Being checked now" : "Not reported",
      detail: running
        ? `Verification cycle ${v.cycle} is checking the newest candidate.`
        : "This verification was sealed before stage results were recorded on the run. The evidence package has them.",
      dot: running ? "running" : null,
      ...from,
      items: all("not_checked"),
    };
  }
  const intent = v.stages.find((s) => s.stage === "intent");
  if (!intent) {
    return { headline: "Not reported", detail: "The newest verification recorded no result for the criteria.", dot: null, ...from, items: all("not_checked") };
  }

  const summary = intent.items.length === 1 ? intent.items[0]!.summary : null;
  const byId = new Map(intent.items.map((item) => [item.id, item]));
  if (criteria.some((c) => byId.has(c.id))) {
    const items = criteria.map((c) => ({ id: c.id, text: c.text, mark: byId.has(c.id) ? MARK_OF[byId.get(c.id)!.status] : ("not_itemised" as const) }));
    const met = items.filter((i) => i.mark === "met").length;
    return { headline: `${met} of ${criteria.length} criteria met`, detail: null, dot: dotForStage(intent.status), ...from, items };
  }

  switch (intent.status) {
    case "passed":
      return { headline: summary ?? `${criteria.length} of ${criteria.length} criteria met`, detail: null, dot: "pass", ...from, items: all("met") };
    case "skipped":
      return { headline: "Not checked", detail: summary, dot: "skipped", ...from, items: all("not_checked") };
    default:
      return {
        headline: summary ?? (intent.status === "failed" ? "Some criteria were not met" : "Some criteria couldn't be settled"),
        detail: "This verification recorded how many were met, not which. The evidence package maps each criterion to its evidence.",
        dot: dotForStage(intent.status),
        ...from,
        items: all("not_itemised"),
      };
  }
}
