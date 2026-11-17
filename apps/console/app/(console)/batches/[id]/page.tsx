import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BatchControls } from "../../../../components/batch-controls.tsx";
import { BatchProgressBar } from "../../../../components/batch-progress.tsx";
import { currentOrganization, getBatch, getIdentity } from "../../../../lib/api.ts";
import { BATCH_STATUS_LABEL, batchControls, itemState, STOP_REASON_LABEL, usd } from "../../../../lib/batches.ts";
import { time } from "../../../../lib/format.ts";
import { changeBatch } from "./actions.ts";

export const metadata: Metadata = { title: "Batch" };

export default async function BatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [detail, identity] = await Promise.all([getBatch(id), getIdentity()]);
  if (!detail) notFound();
  const { batch, items } = detail;
  const p = batch.progress;
  const org = await currentOrganization(identity);
  const controls = batchControls(batch.status, org?.permissions ?? []);

  return (
    <main className="console-main console-main--wide" data-batch-detail={batch.id}>
      <header className="console-header">
        <div>
          <h1>{batch.title}</h1>
          <p className="console-header__sub">
            <span data-batch-status>{BATCH_STATUS_LABEL[batch.status]}</span>
            {batch.stopReason ? ` — ${STOP_REASON_LABEL[batch.stopReason] ?? batch.stopReason}` : ""} ·{" "}
            {batch.kind === "multi_repo" ? "the same change across repositories" : "sub-tasks of one change"} · started {time(batch.createdAt)}
          </p>
        </div>
        <BatchControls controls={controls} change={changeBatch.bind(null, batch.id)} />
      </header>

      <section className="console-section">
        <BatchProgressBar progress={p} legend />
        <dl className="console-kv" data-batch-summary>
          <dt>Children</dt>
          <dd>
            {p.items} · at most {batch.maxConcurrency} at once
          </dd>
          <dt>Verdicts</dt>
          <dd data-batch-verdicts>
            {p.verdicts.pass} pass · {p.verdicts.warn} warn · {p.verdicts.fail} fail · {p.verdicts.none} not yet verified
          </dd>
          <dt>Spent</dt>
          <dd data-batch-spend>
            {usd(p.totalCostUsd)} of {usd(batch.batchSpendCapUsd)}
            {p.remainingBudgetUsd !== null ? ` · ${usd(p.remainingBudgetUsd)} not yet committed to a run` : ""}
          </dd>
          {batch.stopOnFailureRatio !== null ? (
            <>
              <dt>Stops when</dt>
              <dd>{Math.round(batch.stopOnFailureRatio * 100)}% of settled children have failed (after three)</dd>
            </>
          ) : null}
        </dl>
        <p className="oq-muted" style={{ margin: 0 }}>
          Each run below is verified independently, in its own sandbox. Review and merge each pull request on its own.
        </p>
      </section>

      <section className="console-section">
        <h3>Children</h3>
        <table className="console-batch-table" data-batch-items>
          <thead>
            <tr>
              <th>#</th>
              <th>Repository</th>
              <th>State</th>
              <th>Verdict</th>
              <th>Spent</th>
              <th>Pull request</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} data-batch-item={item.ordinal}>
                <td>{item.ordinal + 1}</td>
                <td>
                  {item.repositoryFullName}
                  {item.title ? <div className="console-meta">{item.title}</div> : null}
                </td>
                <td>{item.runId ? <Link href={`/runs/${item.runId}`}>{itemState(item)}</Link> : itemState(item)}</td>
                <td>{item.finalVerdict ?? "—"}</td>
                <td>{usd(item.costUsd)}</td>
                <td>
                  {item.pullRequestUrl ? (
                    <a href={item.pullRequestUrl} rel="noreferrer" target="_blank">
                      #{item.pullRequestNumber}
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
