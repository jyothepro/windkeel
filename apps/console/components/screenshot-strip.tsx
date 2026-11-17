import type { MakerScreenshot } from "../lib/types.ts";

export const NOT_EVIDENCE_LABEL = "Maker screenshots — not verification evidence";

export function screenshotSrc(runId: string, screenshotId: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/screenshots/${encodeURIComponent(screenshotId)}`;
}

export function ScreenshotThumb({ runId, screenshotId, name, url }: { runId: string; screenshotId: string; name: string; url: string | null }) {
  const src = screenshotSrc(runId, screenshotId);
  return (
    <figure className="console-shot" data-screenshot>
      <a href={src} target="_blank" rel="noreferrer">
        <img className="console-shot__img" src={src} alt={`Maker screenshot: ${name}`} loading="lazy" />
      </a>
      <figcaption className="console-meta">
        <span className="console-shot__label">Maker screenshot · unverified</span> {name}
        {url ? <span className="oq-mono"> {url}</span> : null}
      </figcaption>
    </figure>
  );
}

export function ScreenshotStrip({ runId, screenshots }: { runId: string; screenshots: readonly MakerScreenshot[] }) {
  return (
    <section className="console-section" aria-labelledby="maker-screenshots">
      <h2 id="maker-screenshots">{NOT_EVIDENCE_LABEL}</h2>
      <p className="console-guidance-rule">
        The maker agent took these while it built, to check its own work. They are unverified: the independent verifier did not take or check them, and they
        played no part in the verdict. The Evidence tab is the verifier&rsquo;s.
      </p>
      {screenshots.length === 0 ? (
        <p className="oq-muted" style={{ margin: 0 }}>
          The maker hasn&rsquo;t taken any screenshots on this run.
        </p>
      ) : (
        <ol className="console-shots">
          {screenshots.map((s) => (
            <li key={s.id}>
              <ScreenshotThumb runId={runId} screenshotId={s.id} name={s.name ?? "screenshot"} url={s.url} />
              {s.pageTitle ? <p className="console-meta console-shot__title">Title: {s.pageTitle}</p> : null}
              {s.consoleErrors.length ? (
                <details className="console-shot__errors">
                  <summary className="console-meta">
                    {s.consoleErrors.length} console {s.consoleErrors.length === 1 ? "error" : "errors"}
                  </summary>
                  <ul>
                    {s.consoleErrors.map((e, i) => (
                      <li key={i} className="oq-mono">
                        {e}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
