import type { Metadata } from "next";
import Link from "next/link";
import { RunRow } from "../../components/run-list.tsx";
import { listAllRepositories, listInboxRuns, loadModelPicker, takeoverEnabled } from "../../lib/api.ts";
import { inboxGroup } from "../../lib/decision.ts";
import { FileTaskForm } from "./tasks/new/form.tsx";

export const metadata: Metadata = { title: "Home" };

export default async function Home() {
  const [repos, runs, picker, pair] = await Promise.all([listAllRepositories(), listInboxRuns(), loadModelPicker(), takeoverEnabled()]);
  const repoName = new Map(repos.items.map((r) => [r.id, r.fullName]));
  const needsYou = runs.filter((r) => {
    const group = inboxGroup(r.status);
    return group === "decide" || group === "review";
  });

  return (
    <main className="console-main console-home">
      <FileTaskForm repositories={repos.items.map((r) => ({ id: r.id, fullName: r.fullName }))} compact picker={picker} pairMode={pair} />

      <section className="console-section" aria-labelledby="needs-you">
        <div className="console-home__head">
          <h2 id="needs-you">
            Needs you <span className="console-count">{needsYou.length}</span>
          </h2>
          <Link href="/runs" className="console-meta">
            Open the inbox
          </Link>
        </div>
        {needsYou.length === 0 ? (
          <p className="oq-muted" style={{ margin: 0 }}>
            Nothing needs you right now. Decisions and pull requests to review show up here.
          </p>
        ) : (
          <ul className="console-rows">
            {needsYou.map((r) => (
              <li key={r.id}>
                <RunRow run={r} repoName={repoName.get(r.repositoryId) ?? ""} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
