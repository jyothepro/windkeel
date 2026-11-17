import { Skeleton, SkeletonLines } from "../../../../components/skeleton.tsx";

export default function Loading() {
  return (
    <div className="console-run-layout" aria-busy="true">
      <main className="console-run">
        <header className="console-run__header">
          <Skeleton block width="min(32rem, 80%)" height="1.9rem" />
          <div className="console-run__sub">
            <Skeleton width="6rem" />
            <Skeleton width="12rem" />
          </div>
        </header>
        <Skeleton block height="7.5rem" />
        <section className="console-section">
          <Skeleton width="9rem" height="1.2rem" />
          <SkeletonLines lines={4} />
        </section>
        <section className="console-section">
          <Skeleton width="7rem" height="1.2rem" />
          <SkeletonLines lines={5} />
        </section>
      </main>
      <aside className="console-run-panel" aria-label="Evidence">
        <div className="console-run-panel__head">
          <h2>Evidence</h2>
        </div>
        <div className="console-run-panel__body">
          <SkeletonLines lines={3} />
          <Skeleton block height="6rem" />
        </div>
      </aside>
      <span className="oq-sr-only">Loading the run…</span>
    </div>
  );
}
