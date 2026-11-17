import type { Metadata } from "next";
import Link from "next/link";
import { BatchProgressBar } from "../../../components/batch-progress.tsx";
import { IconTasks } from "../../../components/icons.tsx";
import { listBatches } from "../../../lib/api.ts";
import { BATCH_STATUS_LABEL, usd } from "../../../lib/batches.ts";
import { age } from "../../../lib/format.ts";

export const metadata: Metadata = { title: "Batches" };

export default async function BatchesPage() {
  const batches = await listBatches();
  return (
    <main className="console-main console-main--wide">
      <header className="console-header">
        <div>
          <h1>Batches</h1>
          <p className="console-header__sub">One change fanned out into many runs. Every run is verified on its own; a batch only groups and paces them.</p>
        </div>
      </header>

      {batches.items.length === 0 ? (
        <div className="console-empty console-empty--quiet">
          <span className="console-empty__icon">
            <IconTasks />
          </span>
          <h2>No batches yet</h2>
          <p>
            Start one with <code>windkeel batch create</code> or <code>POST /v1/batches</code>.
          </p>
        </div>
      ) : (
        <ul className="console-rows" data-batch-list>
          <li className="console-rows__head" aria-hidden="true">
            <span>Batch</span>
            <span>Progress · spent · created</span>
          </li>
          {batches.items.map((b) => (
            <li key={b.id} data-batch={b.id}>
              <Link className="console-rows__link" href={`/batches/${b.id}`}>
                <span className="console-rows__main">
                  <span className="console-rows__title" title={b.title}>
                    {b.title}
                  </span>
                  <span className="console-rows__sub">
                    {BATCH_STATUS_LABEL[b.status]} · {b.kind === "multi_repo" ? `${b.progress.items} repositories` : `${b.progress.items} sub-tasks`} · {b.progress.succeeded} of{" "}
                    {b.progress.items} verified
                  </span>
                </span>
                <span className="console-rows__end">
                  <BatchProgressBar progress={b.progress} />
                  <span className="console-rows__hide-narrow">
                    {usd(b.progress.totalCostUsd)} of {usd(b.batchSpendCapUsd)}
                  </span>
                  <span>{age(b.createdAt)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
