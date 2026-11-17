import { CRITERION_MARK_LABEL, criteriaCheck, type CriterionMark } from "../lib/criteria-check.ts";
import { time } from "../lib/format.ts";
import type { RunReport } from "../lib/types.ts";
import { StatusDot } from "./status.tsx";

const MARK_DOT: Record<CriterionMark, "pass" | "fail" | "warn" | null> = {
  met: "pass",
  not_met: "fail",
  unsettled: "warn",
  not_itemised: null,
  not_checked: null,
};

export function CriteriaChecklist({ runId, report }: { runId: string; report: RunReport }) {
  const t = report.task;
  const check = criteriaCheck(t.criteria, report.verifications, report.state);
  const provenance =
    t.criteriaProvenance === "generated"
      ? `Written by ${t.criteriaGeneratedBy ?? "a model"}${t.criteriaApprovedBy ? `, approved by ${t.criteriaApprovedBy} ${time(t.criteriaApprovedAt)}` : ", not yet approved"}`
      : "From the issue — the author's own words";
  return (
    <section className="console-section" aria-labelledby="criteria-check">
      <div>
        <h2 id="criteria-check" className="console-checklist__headline">
          {check.dot ? <StatusDot dot={check.dot} decorative /> : null}
          {check.headline}
        </h2>
        <p className="console-meta console-checklist__provenance">
          {t.criteria.length} {t.criteria.length === 1 ? "criterion" : "criteria"} · {provenance}
          {check.cycle !== null ? ` · from verification cycle ${check.cycle}` : ""}
        </p>
      </div>
      {check.detail ? <p className="console-facts">{check.detail}</p> : null}
      <ul className="console-checklist">
        {check.items.map((c) => (
          <li key={c.id} data-mark={c.mark}>
            <span className="console-checklist__mark" aria-hidden="true">
              {MARK_DOT[c.mark] ? <StatusDot dot={MARK_DOT[c.mark]!} decorative /> : <span className="console-checklist__box" />}
            </span>
            <span className="console-checklist__text">{c.text}</span>
            <span className="console-checklist__word">{CRITERION_MARK_LABEL[c.mark]}</span>
          </li>
        ))}
      </ul>
      {check.verificationId ? (
        <p className="console-meta" style={{ margin: 0 }}>
          <a href={`/runs/${runId}/evidence/${check.verificationId}`}>Open the evidence package</a> to see each criterion against its evidence.
        </p>
      ) : null}
    </section>
  );
}
