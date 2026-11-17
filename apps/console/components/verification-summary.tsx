import { OUTCOME_LABEL, stageOutcome, verdictHeadline, verificationPhase, type Outcome } from "../lib/decision.ts";
import type { Dot } from "../lib/run-states.ts";
import type { RunReport, StageResult } from "../lib/types.ts";
import { ApiGap } from "./banner.tsx";
import { StatusDot } from "./status.tsx";

const STAGES: Array<[string, string]> = [
  ["checks", "Repository checks"],
  ["review", "Independent review"],
  ["intent", "Criteria against the change"],
  ["security", "Security scan"],
  ["browser", "Browser QA"],
];

const OUTCOME_DOT: Record<Outcome, Dot | null> = {
  passed: "pass",
  passed_with_warnings: "warn",
  found_issues: "warn",
  failed: "fail",
  not_tested: "skipped",
  unavailable: "warn",
  running: "running",
  not_run_yet: null,
  not_reported: null,
};

export function VerificationSummary({ runId, report }: { runId: string; report: RunReport }) {
  const record = report.verifications.find((v) => v.verdictOfRecord) ?? null;
  const live = !report.terminal;
  const phase = verificationPhase(report.state, record !== null);
  const didNotFinish = new Map(report.incompleteStages.map((s) => [s.stage, s]));
  const byStage = new Map((record?.stages ?? []).map((s) => [s.stage, s]));
  const stageStatus = (stage: string) => byStage.get(stage as StageResult["stage"])?.status ?? null;

  const facts = [
    report.criteria.satisfied === null ? null : `${report.criteria.satisfied} of ${report.criteria.total} criteria met`,
    report.verifications.length ? `${report.verifications.length} verification ${report.verifications.length === 1 ? "cycle" : "cycles"}` : null,
    report.repairAttemptsTaken ? `${report.repairAttemptsTaken} ${report.repairAttemptsTaken === 1 ? "repair" : "repairs"}` : null,
    report.signed === true ? "signed" : report.signed === false ? "not signed" : null,
  ].filter(Boolean);

  return (
    <section className="console-section" aria-labelledby="verification">
      <h2 id="verification" data-verdict={record?.verdict ?? "none"} className="console-verdict">
        {verdictHeadline(record?.verdict ?? null, live)}
      </h2>
      {facts.length ? <p className="console-facts">{facts.join(" · ")}</p> : null}
      {phase === "before" ? (
        <p className="console-facts">An independent verifier checks the change in a separate sandbox once Windkeel has made it.</p>
      ) : null}

      {phase === "before" ? null : (
      <ul className="console-outcomes">
        {STAGES.map(([stage, label]) => {
          const miss = didNotFinish.get(stage);
          const outcome = stageOutcome(stageStatus(stage), Boolean(miss), phase);
          const dot = OUTCOME_DOT[outcome];
          return (
            <li key={stage} id={`stage-${stage}`}>
              <span className="console-outcomes__mark">{dot ? <StatusDot dot={dot} dotOnly>{OUTCOME_LABEL[outcome]}</StatusDot> : null}</span>
              <span className="console-outcomes__stage">{label}</span>
              <span className="console-outcomes__result" data-outcome={outcome}>
                {OUTCOME_LABEL[outcome]}
              </span>
              {miss ? (
                <span className="console-outcomes__why">{miss.detail}</span>
              ) : byStage.get(stage as StageResult["stage"])?.items.length === 1 && byStage.get(stage as StageResult["stage"])!.items[0]!.summary ? (
                <span className="console-outcomes__why">{byStage.get(stage as StageResult["stage"])!.items[0]!.summary}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
      )}

      {record ? (
        record.stages ? (
          <p className="console-meta" style={{ margin: 0 }}>
            <a href={`/runs/${runId}/evidence/${record.id}`}>Open the evidence package</a> for transcripts and findings.
          </p>
        ) : (
          <ApiGap gap="G3" title="Stage results are inside the evidence package">
            This verification was sealed before stage results were recorded on the run. <a href={`/runs/${runId}/evidence/${record.id}`}>Open the package</a> for them.
          </ApiGap>
        )
      ) : null}
    </section>
  );
}
