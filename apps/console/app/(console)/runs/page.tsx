import type { Metadata } from "next";
import Link from "next/link";
import { FilterSelect } from "../../../components/filter-select.tsx";
import { IconInbox, IconPlus } from "../../../components/icons.tsx";
import { RunRow } from "../../../components/run-list.tsx";
import { listAllRepositories, listInboxRunsWithFailed } from "../../../lib/api.ts";
import { INBOX_GROUPS, inboxGroup, type InboxGroup } from "../../../lib/decision.ts";
import type { RunSummary } from "../../../lib/types.ts";

export const metadata: Metadata = { title: "Inbox" };

const FINISHED_SHOWN = 10;

const VIEWS = [
  ["all", "All", ["decide", "review", "in_progress", "failed", "done"]],
  ["needs", "Needs you", ["decide", "review"]],
  ["working", "In progress", ["in_progress"]],
  ["failed", "Failed", ["failed"]],
  ["done", "Done", ["done"]],
] as const satisfies ReadonlyArray<readonly [string, string, readonly InboxGroup[]]>;
type View = (typeof VIEWS)[number][0];

type Search = { repository?: string; status?: string; view?: string };

export default async function InboxPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const { repository, status } = search;
  const view: View = VIEWS.find(([v]) => v === search.view)?.[0] ?? "all";
  const [{ runs: all, failedTruncated }, repos] = await Promise.all([listInboxRunsWithFailed(), listAllRepositories()]);
  const runs = all.filter((r) => (!repository || r.repositoryId === repository) && (!status || r.status === status));
  const repoName = new Map(repos.items.map((r) => [r.id, r.fullName]));

  if (all.length === 0) {
    return (
      <main className="console-main">
        <div className="console-empty">
          <span className="console-empty__icon">
            <IconInbox />
          </span>
          <h2>Nothing here yet</h2>
          <p className="oq-muted">Tell Windkeel what to change. It does the work, checks it independently, and brings you a pull request with the evidence.</p>
          <a className="oq-button oq-button--primary oq-button--lg" href="/tasks/new">
            Give Windkeel a task
          </a>
        </div>
      </main>
    );
  }

  const byGroup = new Map<InboxGroup, RunSummary[]>(INBOX_GROUPS.map(([g]) => [g, []]));
  for (const r of runs) byGroup.get(inboxGroup(r.status))!.push(r);
  const count = (groups: readonly InboxGroup[]) => groups.reduce((n, g) => n + byGroup.get(g)!.length, 0);
  const shownCount = (groups: readonly InboxGroup[]) => `${count(groups)}${failedTruncated && groups.includes("failed") ? "+" : ""}`;
  const waiting = count(["decide", "review"]);
  const groups = VIEWS.find(([v]) => v === view)![2];
  const href = (v: View) => {
    const q = new URLSearchParams(Object.entries({ repository, status, view: v === "all" ? undefined : v }).filter((e): e is [string, string] => Boolean(e[1])));
    return q.size ? `/runs?${q}` : "/runs";
  };

  return (
    <main className="console-main console-main--wide">
      <header className="console-header">
        <div>
          <h1>Inbox</h1>
          <p className="console-header__sub">
            {waiting === 0 ? "Nothing needs you right now." : `${waiting} ${waiting === 1 ? "run needs" : "runs need"} you.`}
          </p>
        </div>
      </header>

      <div className="console-toolbar">
        <nav className="oq-tabs oq-tabs--pills" aria-label="Inbox views">
          {VIEWS.map(([v, label, gs]) => (
            <Link key={v} className="oq-tab" href={href(v)} aria-current={view === v ? "page" : undefined}>
              {label} <span className="oq-tab__count">{shownCount(gs)}</span>
            </Link>
          ))}
        </nav>
        <div className="console-toolbar__end">
          {repos.items.length > 1 ? (
            <FilterSelect name="repository" label="Repository" all="All repositories" options={repos.items.map((r) => ({ value: r.id, label: r.fullName }))} />
          ) : null}
          <a className="oq-button oq-button--primary oq-button--sm" href="/tasks/new">
            <IconPlus small />
            New task
          </a>
        </div>
      </div>

      {count(groups) === 0 ? (
        <div className="console-empty console-empty--quiet">
          <h2>{view === "needs" ? "Nothing needs you" : "No runs here"}</h2>
          <p>{view === "needs" ? "Decisions and pull requests to review show up here." : repository ? "Nothing matches this repository." : "Runs show up here as Windkeel works."}</p>
        </div>
      ) : (
        <ul className="console-rows">
          {INBOX_GROUPS.filter(([g]) => (groups as readonly InboxGroup[]).includes(g)).map(([group, label]) => {
            const items = byGroup.get(group)!;
            if (items.length === 0) return null;
            const finished = group === "done" || group === "failed";
            const shown = finished && view === "all" ? items.slice(0, FINISHED_SHOWN) : items;
            return [
              <li key={`${group}-label`} className="console-rows__group" id={`inbox-${group}`}>
                {label} <span className="console-count">{shownCount([group])}</span>
              </li>,
              ...shown.map((r) => (
                <li key={r.id}>
                  <RunRow run={r} repoName={repoName.get(r.repositoryId) ?? ""} />
                </li>
              )),
              shown.length < items.length ? (
                <li key={`${group}-more`} className="console-rows__more">
                  <Link href={href(group === "failed" ? "failed" : "done")}>and {items.length - shown.length} more</Link>
                </li>
              ) : null,
            ];
          })}
        </ul>
      )}
    </main>
  );
}
