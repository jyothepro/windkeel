export default function NotFound() {
  return (
    <main className="console-main">
      <div className="console-empty">
        <h2>Not here</h2>
        <p className="oq-muted">No run, task or repository has that id. It may belong to a different factory.</p>
        <a className="oq-button" href="/runs">
          Back to runs
        </a>
      </div>
    </main>
  );
}
