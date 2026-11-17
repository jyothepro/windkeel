import { progressSegments, type BatchProgress } from "../lib/batches.ts";

export function BatchProgressBar({ progress, legend = false }: { progress: BatchProgress; legend?: boolean }) {
  const segments = progressSegments(progress);
  const total = Math.max(1, progress.items);
  const summary = segments.map((s) => `${s.count} ${s.label}`).join(", ");
  return (
    <>
      <div className="console-batch-progress" role="img" aria-label={`${progress.items} children: ${summary}`} data-batch-progress>
        {segments.map((s) => (
          <span key={s.key} className="console-batch-progress__seg" data-kind={s.key} style={{ width: `${(s.count / total) * 100}%` }} />
        ))}
      </div>
      {legend ? (
        <ul className="console-batch-legend">
          {segments.map((s) => (
            <li key={s.key} data-segment={s.key}>
              {s.count} {s.label}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
