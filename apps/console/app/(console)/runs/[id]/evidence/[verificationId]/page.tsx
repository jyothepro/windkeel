import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ApiGap } from "../../../../../../components/banner.tsx";
import { StatusDot, VerdictBadge } from "../../../../../../components/status.tsx";
import { getRun, getRunEvidenceOrNull } from "../../../../../../lib/api.ts";
import { shortSha, time } from "../../../../../../lib/format.ts";
import { dotForStage } from "../../../../../../lib/run-states.ts";
import type { EvidenceStatus, StageResult } from "../../../../../../lib/types.ts";

export const metadata: Metadata = { title: "Verification" };

const STAGE_LABEL: Record<StageResult["stage"], string> = {
  checks: "Repository checks",
  review: "Independent review",
  intent: "Criteria against the change",
  security: "Security scan",
  browser: "Browser QA",
};

const STATUS_LABEL: Record<EvidenceStatus, string> = {
  passed: "Passed",
  warning: "Warning",
  failed: "Failed",
  completed_with_findings: "Found issues",
  skipped: "Not tested",
};

export default async function VerificationPage({ params }: { params: Promise<{ id: string; verificationId: string }> }) {
  const { id, verificationId } = await params;
  const [detail, evidence] = await Promise.all([getRun(id), getRunEvidenceOrNull(id)]);
  const verification = detail?.report.verifications.find((v) => v.id === verificationId);
  const entry = evidence?.items.find((e) => e.verificationRunId === verificationId);
  if (!detail || !verification) notFound();

  return (
    <main className="console-main">
      <header className="console-header">
        <div>
          <h1>Cycle {verification.cycle}</h1>
          <div className="console-header__sub">
            <Link href={`/runs/${id}?tab=evidence`}>{detail.report.task.title}</Link> ·{" "}
            <span className="oq-mono">{shortSha(verification.candidateSha)}</span>
          </div>
        </div>
        <VerdictBadge verdict={verification.verdict} />
      </header>

      <dl className="console-kv">
        <dt>Verdict of record</dt>
        <dd>{verification.verdictOfRecord ? "yes" : verification.superseded ? "no — a later cycle superseded it" : "no"}</dd>
        <dt>Completed</dt>
        <dd>{time(verification.completedAt)}</dd>
        <dt>Package</dt>
        <dd>
          {evidence === null
            ? "not available — this deployment has no evidence storage configured"
            : entry?.state === "pruned"
              ? `pruned ${time(entry.prunedAt)} — the digest is kept, so the verdict stays checkable`
              : entry?.state === "never_produced"
                ? "never produced — no verification got far enough to seal one"
                : entry?.state === "stored"
                  ? "stored"
                  : "not reported"}
        </dd>
        <dt>Digest</dt>
        <dd className="oq-mono">{entry?.manifestDigest ?? "—"}</dd>
      </dl>

      {verification.stages ? (
        <section className="console-section" aria-labelledby="stages">
          <h3 id="stages">Stages</h3>
          <ul className="console-outcomes">
            {(Object.keys(STAGE_LABEL) as StageResult["stage"][]).map((stage) => {
              const s = verification.stages!.find((r) => r.stage === stage);
              return (
                <li key={stage} id={`stage-${stage}`}>
                  <span className="console-outcomes__mark">
                    {s ? (
                      <StatusDot dot={dotForStage(s.status)} dotOnly>
                        {STATUS_LABEL[s.status]}
                      </StatusDot>
                    ) : null}
                  </span>
                  <span className="console-outcomes__stage">{STAGE_LABEL[stage]}</span>
                  <span className="console-outcomes__result" data-outcome={s ? undefined : "not_reported"}>
                    {s ? STATUS_LABEL[s.status] : "Not reported"}
                  </span>
                  {s?.items.map((item) => (
                    <span key={item.id} className="console-outcomes__why">
                      {item.summary ?? item.type}
                      {s.items.length > 1 ? ` — ${STATUS_LABEL[item.status].toLowerCase()}` : null}
                    </span>
                  ))}
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        <ApiGap gap="G3" title="Stage results are inside the package">
          This verification was sealed before stage results were recorded on the run. Download the package below for them.
        </ApiGap>
      )}

      {entry?.files?.length ? (
        <section className="console-section">
          <h3>Files</h3>
          <ul className="oq-stack" style={{ margin: 0, paddingLeft: "var(--space-5)" }}>
            {entry.files.map((f) => (
              <li key={f} className="oq-mono">
                <a
                  href={`/api/runs/${encodeURIComponent(id)}/evidence/${f.split("/").map(encodeURIComponent).join("/")}?verification=${encodeURIComponent(verificationId)}`}
                >
                  {f}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
