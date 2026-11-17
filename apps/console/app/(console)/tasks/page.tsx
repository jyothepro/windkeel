import type { Metadata } from "next";
import Link from "next/link";
import { FilterSelect } from "../../../components/filter-select.tsx";
import { IconPlus, IconTasks } from "../../../components/icons.tsx";
import { SourceBadge } from "../../../components/source-badge.tsx";
import { listAllRepositories, listTasks } from "../../../lib/api.ts";
import { age } from "../../../lib/format.ts";

export const metadata: Metadata = { title: "Tasks" };

const RISK = { low: "routine", medium: "standard", high: "sensitive" } as const;

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ repository?: string; status?: string; source?: string }> }) {
  const filter = await searchParams;
  const [tasks, repos] = await Promise.all([listTasks(filter), listAllRepositories()]);
  const repoName = new Map(repos.items.map((r) => [r.id, r.fullName]));

  return (
    <main className="console-main console-main--wide">
      <header className="console-header">
        <div>
          <h1>Tasks</h1>
          <p className="console-header__sub">What Windkeel was asked to change. Each task has its criteria and every run of it.</p>
        </div>
      </header>

      <div className="console-toolbar">
        <div className="console-toolbar__end">
          {repos.items.length > 1 ? (
            <FilterSelect name="repository" label="Repository" all="All repositories" options={repos.items.map((r) => ({ value: r.id, label: r.fullName }))} />
          ) : null}
        </div>
        <a className="oq-button oq-button--primary oq-button--sm" href="/tasks/new">
          <IconPlus small />
          New task
        </a>
      </div>

      {tasks.items.length === 0 ? (
        <div className="console-empty console-empty--quiet">
          <span className="console-empty__icon">
            <IconTasks />
          </span>
          <h2>No tasks yet</h2>
          <p>Label an issue for Windkeel, or give it one here.</p>
        </div>
      ) : (
        <ul className="console-rows">
          <li className="console-rows__head" aria-hidden="true">
            <span>Task</span>
            <span>Repository · created</span>
          </li>
          {tasks.items.map((t) => (
            <li key={t.id}>
              <Link className="console-rows__link" href={`/tasks/${t.id}`}>
                <span className="console-rows__main">
                  <span className="console-rows__title" title={t.title}>
                    {t.title}
                  </span>
                  <span className="console-rows__sub">
                    <SourceBadge task={t} withDetail={false} link={false} />{" "}
                    {t.criteriaProvenance === "generated" ? "Criteria written by Windkeel" : "Criteria from the task"} · {RISK[t.riskLevel]}
                  </span>
                </span>
                <span className="console-rows__end">
                  <span className="console-rows__hide-narrow">{repoName.get(t.repositoryId) ?? ""}</span>
                  <span>{age(t.createdAt)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
