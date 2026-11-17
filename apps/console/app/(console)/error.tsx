"use client";

export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const detail = process.env.NODE_ENV === "production" ? null : error.message;
  return (
    <main className="console-main">
      <div className="oq-banner" data-intent="danger" role="alert">
        <div>
          <strong className="oq-banner__title">This page couldn't load</strong>
          <p className="oq-banner__body">
            {detail ?? "The console's server failed while building this page."} Try again in a moment. If it keeps failing,{" "}
            <a href="/settings/general">Settings</a> shows whether the control plane can reach its database.
          </p>
          {error.digest ? (
            <p className="oq-banner__body console-meta">
              Error digest <span className="oq-mono">{error.digest}</span>: it finds this failure in the console's logs.
            </p>
          ) : null}
        </div>
        <div className="oq-banner__actions">
          <button type="button" className="oq-button oq-button--sm" onClick={reset}>
            Try again
          </button>
        </div>
      </div>
    </main>
  );
}
