import Link from "next/link";
import { nextAction, nextActionTone } from "../lib/decision.ts";
import { age } from "../lib/format.ts";
import { dotForRun, stateLabel } from "../lib/run-states.ts";
import type { RepositorySummary, RunSummary } from "../lib/types.ts";
import { IconPullRequest } from "./icons.tsx";
import { StatusDot } from "./status.tsx";

export function RunRow({ run, repoName }: { run: RunSummary; repoName: string }) {
  const tone = nextActionTone(run.status);
  return (
    <Link className="console-rows__link" href={`/runs/${run.id}`}>
      <StatusDot dot={dotForRun(run.status, run.finalVerdict)} dotOnly>
        {stateLabel(run.status)}
      </StatusDot>
      <span className="console-rows__main">
        <span className="console-rows__title" title={run.taskTitle}>
          {run.taskTitle}
        </span>
        <span className="console-rows__sub" data-yours={tone === "yours"} data-tone={tone ?? undefined}>
          {nextAction({ ...run, state: run.status })}
        </span>
      </span>
      <span className="console-rows__end">
        {run.prNumber ? (
          <span className="console-rows__pr" title={`Pull request #${run.prNumber}`}>
            <IconPullRequest small />#{run.prNumber}
          </span>
        ) : null}
        <span className="console-rows__hide-narrow">{repoName}</span>
        <span>{age(run.createdAt)}</span>
      </span>
    </Link>
  );
}

export function RunList({ runs, repositories }: { runs: RunSummary[]; repositories: RepositorySummary[] }) {
  const repoName = new Map(repositories.map((r) => [r.id, r.fullName]));
  return (
    <ul className="console-rows">
      {runs.map((r) => (
        <li key={r.id}>
          <RunRow run={r} repoName={repoName.get(r.repositoryId) ?? ""} />
        </li>
      ))}
    </ul>
  );
}
