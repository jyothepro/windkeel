import Link from "next/link";
import { Banner } from "../../../../components/banner.tsx";
import { StatusDot, VerdictBadge } from "../../../../components/status.tsx";
import { getRunCost } from "../../../../lib/api.ts";
import { costBySource, costLabel, keySourceLabel, showsSourceSplit } from "../../../../lib/cost.ts";
import { shortSha, time, usd } from "../../../../lib/format.ts";
import type { CostBreakdown, RunReport } from "../../../../lib/types.ts";
import { credits, roleLabel, type RunReceiptView } from "../../../../lib/credits.ts";

export async function CostTab({ runId, receipt }: { runId: string; receipt: RunReceiptView | undefined }) {
  const cost = await getRunCost(runId);
  return (
    <>
      {receipt && (receipt.compute.length > 0 || receipt.ai.length > 0) ? <Receipt receipt={receipt} /> : null}
      <Cost cost={cost} />
    </>
  );
}

function Receipt({ receipt }: { receipt: RunReceiptView }) {
  return (
    <div className="console-table-wrap" data-receipt>
      <table className="console-table" aria-label="Receipt in credits">
        <thead>
          <tr>
            <th>Receipt</th>
            <th>Role</th>
            <th>Detail</th>
            <th className="console-num">Credits</th>
          </tr>
        </thead>
        <tbody>
          {receipt.compute.map((c) => (
            <tr key={`compute:${c.role}`}>
              <td>Compute</td>
              <td>{roleLabel(c.role)}</td>
              <td className="console-meta">
                {c.sandboxMinutes.toFixed(2)} sandbox-minutes × {c.creditsPerMinute}
              </td>
              <td className="console-num">{credits(c.credits)}</td>
            </tr>
          ))}
          {receipt.ai.map((a) => (
            <tr key={`ai:${a.role}:${a.model ?? ""}:${a.keySource}`}>
              <td>AI</td>
              <td>{roleLabel(a.role)}</td>
              <td className="console-meta">
                {a.model ?? "model not recorded"} · {a.tokensIn.toLocaleString()} in / {a.tokensOut.toLocaleString()} out
                {a.keySource === "customer" ? " · your key, compute only" : ""}
                {a.unpricedCalls ? ` · ${a.unpricedCalls} unpriced, not billed` : ""}
              </td>
              <td className="console-num">{credits(a.credits)}</td>
            </tr>
          ))}
          <tr>
            <td colSpan={3}>
              <strong>Total</strong> <span className="console-meta">· 1 credit = $0.01</span>
            </td>
            <td className="console-num" data-receipt-total>
              <strong>{credits(receipt.totals.credits)}</strong>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export async function RisksSection({ runId, report }: { runId: string; report: RunReport }) {
  return <Risks report={report} cost={await getRunCost(runId)} />;
}

export const record = (report: RunReport) => report.verifications.find((v) => v.verdictOfRecord) ?? null;

function Risks({ report, cost }: { report: RunReport; cost: CostBreakdown }) {
  const items: Array<{ title: string; body: string; intent: "warning" | "danger" | "info" }> = [];
  for (const s of report.incompleteStages)
    items.push({ intent: "warning", title: `${s.stage}: test unavailable`, body: `${s.tool} did not finish — ${s.detail}` });
  if (report.task.criteriaProvenance === "generated" && !report.task.criteriaApprovedBy && report.state !== "WAITING_FOR_APPROVAL")
    items.push({ intent: "warning", title: "Criteria were never approved", body: "A model wrote the bar this change was judged against, and no person signed it off." });
  if (report.signed === false) items.push({ intent: "info", title: "The evidence isn't signed", body: "The package was sealed, but no signature was attached." });
  for (const s of report.pendingSignals)
    items.push({ intent: "warning", title: `A ${s.kind} nothing has read`, body: `Recorded ${time(s.receivedAt)}, and nothing is coming to act on it.` });
  if (report.cost.unpricedModelCalls > 0)
    items.push({ intent: "info", title: "Cost is a lower bound", body: `${report.cost.unpricedModelCalls} model ${report.cost.unpricedModelCalls === 1 ? "call" : "calls"} had no price.` });
  if (Math.abs(cost.totalUsd - cost.runRowCost) > 0.00005)
    items.push({ intent: "danger", title: "The run's cost and its ledger disagree", body: `${usd(cost.runRowCost)} on the run, ${usd(cost.totalUsd)} in the ledger.` });

  return (
    <section className="console-section" aria-labelledby="risks">
      <h2 id="risks">Needs a look</h2>
      {items.length === 0 ? (
        <p className="oq-muted" style={{ margin: 0 }}>
          Nothing flagged.
        </p>
      ) : (
        <div className="oq-stack" style={{ ["--gap" as string]: "var(--space-2)" }}>
          {items.map((i) => (
            <Banner key={i.title} intent={i.intent} title={i.title}>
              <p>{i.body}</p>
            </Banner>
          ))}
        </div>
      )}
    </section>
  );
}

export function Verifications({ runId, report }: { runId: string; report: RunReport }) {
  if (report.verifications.length === 0) return <p className="oq-muted">No verification has run yet.</p>;
  return (
    <ul className="console-list">
      {report.verifications.map((v) => (
        <li key={v.id}>
          <Link className="console-list__row" href={`/runs/${runId}/evidence/${v.id}`} style={v.superseded ? { opacity: 0.65 } : undefined}>
            <span className="console-list__main">
              <span className="console-list__title">
                Cycle {v.cycle}
                {v.verdictOfRecord ? " · verdict of record" : v.superseded ? " · superseded" : ""}
              </span>
              <span className="console-list__next">
                <span className="oq-mono">{shortSha(v.candidateSha)}</span> · package {v.evidence.state} · {time(v.completedAt)}
              </span>
            </span>
            {v.verdict ? <VerdictBadge verdict={v.verdict} /> : <StatusDot dot="running">running</StatusDot>}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function Attempts({ report }: { report: RunReport }) {
  const items = report.repairAttempts;
  if (items.length === 0) return <p className="oq-muted">No repairs. The first verification decided this run.</p>;
  return (
    <ol className="console-list">
      {items.map((a) => (
        <li key={a.attemptNumber} className="console-list__static">
          <span className="console-list__main">
            <span className="console-list__title">
              Repair {a.attemptNumber}
              {a.taken ? "" : " · not taken — a limit stopped the run first"}
            </span>
            <span className="console-list__next">
              {[
                a.blockingFindings.length ? `Fixing: ${a.blockingFindings.join("; ")}` : null,
                a.failedChecks.length ? `failed checks: ${a.failedChecks.join(", ")}` : null,
                a.failedCriteria.length ? `unmet criteria: ${a.failedCriteria.join(", ")}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function Cost({ cost }: { cost: CostBreakdown }) {
  const sources = costBySource(cost);
  const split = showsSourceSplit(sources);
  return (
    <div className="console-table-wrap">
      {split ? (
        <table className="console-table" aria-label="Model cost by key">
          <thead>
            <tr>
              <th>Paid with</th>
              <th className="console-num">Model calls</th>
              <th className="console-num">Model cost</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((source) => (
              <tr key={source.keySource ?? "unrecorded"}>
                <td>{source.label}</td>
                <td className="console-num">{source.events.toLocaleString()}</td>
                <td className="console-num">
                  {costLabel(usd(source.usd), source.unpricedEvents)}
                  {source.unpricedEvents ? <span className="console-meta"> · {source.unpricedEvents} unpriced</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <table className="console-table">
        <thead>
          <tr>
            <th>Stage</th>
            <th>Kind</th>
            {split ? <th>Paid with</th> : null}
            <th className="console-num">Tokens in</th>
            <th className="console-num">Tokens out</th>
            <th className="console-num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {cost.byStage.map((row) => (
            <tr key={`${row.stageType}:${row.kind}:${row.keySource ?? ""}`}>
              <td>{row.stageType}</td>
              <td>{row.kind}</td>
              {split ? <td>{row.kind === "model" ? keySourceLabel(row.keySource) : "—"}</td> : null}
              <td className="console-num">{row.tokensIn?.toLocaleString() ?? "—"}</td>
              <td className="console-num">{row.tokensOut?.toLocaleString() ?? "—"}</td>
              <td className="console-num">{row.unpricedEvents && !row.usd ? "unpriced" : costLabel(usd(row.usd), row.unpricedEvents)}</td>
            </tr>
          ))}
          <tr>
            <td colSpan={split ? 5 : 4}>
              <strong>Total</strong>
              {cost.spendCapUsd !== null ? <span className="console-meta"> · limit {usd(cost.spendCapUsd)}</span> : null}
              {cost.unpricedEvents ? <span className="console-meta"> · {cost.unpricedEvents} model {cost.unpricedEvents === 1 ? "call" : "calls"} unpriced</span> : null}
            </td>
            <td className="console-num">
              <strong>{costLabel(usd(cost.totalUsd), cost.unpricedEvents)}</strong>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
