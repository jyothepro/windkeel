import type { Metadata } from "next";
import { getMetrics } from "../../../lib/api.ts";

export const metadata: Metadata = { title: "Metrics" };

export default async function MetricsPage() {
  const metrics = await getMetrics();
  return (
    <main className="console-main">
      <header className="console-header">
        <div>
          <h1>Metrics</h1>
          <p className="console-header__sub">The views as the API returns them. A blank is not measured, never zero.</p>
        </div>
      </header>
      <ul className="console-rows">
        {Object.entries(metrics).map(([key, value]) => (
          <li key={key} className="console-rows__static console-metric">
            <span className="oq-mono console-metric__key">{key}</span>
            <span className="console-metric__value">{render(value)}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}

function render(value: unknown): React.ReactNode {
  if (value === null || value === undefined) return <span className="console-meta">not measured</span>;
  if (typeof value === "object") return <pre className="oq-mono" style={{ margin: 0, fontSize: "var(--font-size-sm)" }}>{JSON.stringify(value, null, 2)}</pre>;
  return String(value);
}
