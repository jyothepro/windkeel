export function Skeleton({ width, height, block = false }: { width?: string; height?: string; block?: boolean }) {
  return <span className="console-skeleton" data-block={block || undefined} style={{ width, height }} aria-hidden="true" />;
}

export function SkeletonLines({ lines = 3 }: { lines?: number }) {
  return (
    <div className="console-skeleton-lines" aria-busy="true">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} block width={i === lines - 1 && lines > 1 ? "62%" : "100%"} />
      ))}
      <span className="oq-sr-only">Loading…</span>
    </div>
  );
}

export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <main className="console-main" aria-busy="true">
      <div className="console-header">
        <Skeleton width="11rem" height="2rem" />
      </div>
      <Skeleton block width="18rem" height="2rem" />
      <ul className="console-list console-skeleton-list">
        {Array.from({ length: rows }, (_, i) => (
          <li key={i} className="console-list__static">
            <span className="console-list__main">
              <Skeleton width={`${60 - (i % 3) * 12}%`} />
              <Skeleton width="34%" />
            </span>
          </li>
        ))}
      </ul>
      <span className="oq-sr-only">Loading…</span>
    </main>
  );
}
