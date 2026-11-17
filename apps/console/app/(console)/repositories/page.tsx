import type { Metadata } from "next";
import Link from "next/link";
import { IconBranch, IconRepo, IconSearch } from "../../../components/icons.tsx";
import { listAllRepositories } from "../../../lib/api.ts";

export const metadata: Metadata = { title: "Repositories" };

export default async function RepositoriesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = ((await searchParams).q ?? "").trim();
  const repos = await listAllRepositories();
  const shown = q ? repos.items.filter((r) => r.fullName.toLowerCase().includes(q.toLowerCase())) : repos.items;

  return (
    <main className="console-main console-main--wide">
      <header className="console-header">
        <div>
          <h1>Repositories</h1>
          <p className="console-header__sub">Where Windkeel can work: the repositories the GitHub App is installed on.</p>
        </div>
      </header>

      {repos.items.length === 0 ? (
        <div className="console-empty console-empty--quiet">
          <span className="console-empty__icon">
            <IconRepo />
          </span>
          <h2>No repositories yet</h2>
          <p>Install the GitHub App on one (docs/github-app.md).</p>
        </div>
      ) : (
        <>
          <div className="console-toolbar">
            <p className="console-meta" style={{ margin: 0 }}>
              {q ? `${shown.length} of ${repos.items.length}` : `${repos.items.length} ${repos.items.length === 1 ? "repository" : "repositories"}`}
            </p>
            <form className="console-search" role="search" method="get" action="/repositories">
              <IconSearch small />
              <label className="oq-sr-only" htmlFor="repo-search">
                Search repositories
              </label>
              <input id="repo-search" name="q" className="oq-input" placeholder="Search repositories" defaultValue={q} autoComplete="off" />
            </form>
          </div>
          {shown.length === 0 ? (
            <div className="console-empty console-empty--quiet">
              <h2>No repository matches “{q}”</h2>
              <p>
                <Link href="/repositories">Show all</Link>
              </p>
            </div>
          ) : (
            <ul className="console-grid" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {shown.map((r) => {
                const [owner, name] = r.fullName.includes("/") ? r.fullName.split("/", 2) : ["", r.fullName];
                return (
                  <li key={r.id} style={{ display: "contents" }}>
                    <Link className="console-tile" href={`/repositories/${r.id}`}>
                      <span className="console-tile__top">
                        <span className="console-tile__title">{name}</span>
                        <IconRepo />
                      </span>
                      <span className="console-tile__sub">{owner}</span>
                      <span className="console-tile__facts">
                        <span className="oq-mono">
                          <IconBranch small />
                          {r.defaultBranch ?? "—"}
                        </span>
                        <span>
                          {r.openRuns} open {r.openRuns === 1 ? "run" : "runs"}
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
