import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache, Suspense } from "react";
import { ActivityFeed } from "../../../../components/activity-feed.tsx";
import { DiffView } from "../../../../components/diff-view.tsx";
import { Composer } from "../../../../components/composer.tsx";
import { DecisionCard } from "../../../../components/decision-card.tsx";
import { GuidanceList } from "../../../../components/guidance-list.tsx";
import { ModelsPanel } from "../../../../components/models-panel.tsx";
import { KnowledgePanel } from "../../../../components/knowledge-panel.tsx";
import { Skeleton, SkeletonLines } from "../../../../components/skeleton.tsx";
import { StageRail } from "../../../../components/stage-rail.tsx";
import { StatusDot, VerdictBadge } from "../../../../components/status.tsx";
import { CriteriaChecklist } from "../../../../components/criteria-checklist.tsx";
import { ProgressScrubber } from "../../../../components/progress-scrubber.tsx";
import { VerificationSummary } from "../../../../components/verification-summary.tsx";
import { PlaybookBadge, SourceBadge } from "../../../../components/source-badge.tsx";
import { TerminalLog } from "../../../../components/terminal-log.tsx";
import { WorkspaceFiles } from "../../../../components/workspace-files.tsx";
import { HumanWorkspacePanel } from "../../../../components/human-workspace.tsx";
import { ScreenshotStrip } from "../../../../components/screenshot-strip.tsx";
import {
  AGENT_TAIL,
  getRun,
  getRunAgentEvents,
  getRunDiff,
  getRunEventsTail,
  getRunMessages,
  getRunTransitions,
  getRunWorkspace,
  getRunScreenshots,
  currentOrganization,
  getIdentity,
  getMergeEligibility,
  getTask,
  listAllRepositories,
  listRuns,
  loadModelPicker,
  openableTabs,
} from "../../../../lib/api.ts";
import { snapshotLine } from "../../../../lib/models.ts";
import { decisionFor } from "../../../../lib/decision.ts";
import { mergeFacts } from "../../../../lib/merge.ts";
import { shortSha, time } from "../../../../lib/format.ts";
import {
  dotForRun,
  guidanceClosedReason,
  parkedOnPerson,
  stateLabel,
  type RunState,
} from "../../../../lib/run-states.ts";
import {
  EVIDENCE_VIEWS,
  tabsFor,
  workspaceHref,
  workspaceTab,
  workspaceTarget,
  type EvidenceView,
} from "../../../../lib/session.ts";
import {
  canStartSession,
  editorName,
  missedTakeoverNotice,
  provenanceLabel,
  takeoverOf,
} from "../../../../lib/takeover.ts";
import { filesTouched, terminalOf } from "../../../../lib/terminal.ts";
import { candidateOfTurn, scopeToTurn } from "../../../../lib/turn-changes.ts";
import { parentOf } from "../../../../lib/workspace-files.ts";
import type { RunDetail, RunReport } from "../../../../lib/types.ts";
import { Attempts, CostTab, RisksSection, Verifications, record } from "./report-sections.tsx";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; view?: string; path?: string; turn?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const detail = await getRun((await params).id);
  return { title: detail?.report.task.title ?? "Run" };
}

const pullRequestOf = cache(async (runId: string, taskId: string) => {
  const [runsOfTask, repos] = await Promise.all([listRuns({ task: taskId }), listAllRepositories()]);
  const summary = runsOfTask.items.find((r) => r.id === runId) ?? null;
  const repo = repos.items.find((r) => r.id === summary?.repositoryId) ?? null;
  const url = repo && summary?.prNumber ? `https://github.com/${repo.fullName}/pull/${summary.prNumber}` : null;
  return { summary, repo, url };
});

const tailOf = cache((runId: string) => getRunEventsTail(runId).catch(() => null));

export default async function RunPage({ params, searchParams }: Props) {
  const { id } = await params;
  const detail = await getRun(id);
  if (!detail) notFound();
  const { report } = detail;
  const search = await searchParams;
  const takeover = takeoverOf(detail);
  const humanWorkspace = takeover !== null && report.state === "HUMAN_EDITING" && takeover.session !== null;
  const missed = missedTakeoverNotice(takeover, report.state);
  const { tab, view } = workspaceTab(search, report.state, humanWorkspace);
  const target = workspaceTarget(search);
  const working = report.state === "IMPLEMENTING" || report.state === "REPAIRING";
  const taskId = report.task.id;
  const guidanceClosed = guidanceClosedReason(report.state);
  const verdict = record(report)?.verdict ?? null;

  return (
    <div className="console-session">
      <header className="console-run__header console-session__head">
        <h1>{report.task.title}</h1>
        <div className="console-run__sub">
          <span title={`Run ${id}`}>
            <StatusDot dot={dotForRun(report.state, report.finalVerdict)}>{stateLabel(report.state)}</StatusDot>
          </span>
          <Suspense fallback={<Skeleton width="14rem" />}>
            <RunLinks runId={id} taskId={taskId} />
          </Suspense>
          <RunSnapshot config={detail.modelConfig} />
          {detail.batch ? (
            <Link href={`/batches/${detail.batch.id}`} data-run-batch>
              Part of batch {detail.batch.title}
            </Link>
          ) : null}
        </div>
      </header>

      <Suspense fallback={<div className="console-session__decision-skeleton"><Skeleton block height="7.5rem" /></div>}>
        <Decision runId={id} detail={detail} />
      </Suspense>
      {missed ? (
        <p className="console-meta" role="status">
          {missed}
        </p>
      ) : null}

      <aside className="console-workspace" aria-label="Workspace">
        <nav className="oq-tabs console-workspace__tabs" aria-label="Workspace">
          {tabsFor(humanWorkspace).map(([key, label]) => (
            <Link key={key} className="oq-tab" aria-current={tab === key ? "page" : undefined} href={workspaceHref(id, key)} scroll={false}>
              {label}
              {key === "criteria" ? <span className="oq-tab__count">{report.task.criteria.length}</span> : null}
              {key === "evidence" && verdict ? <VerdictBadge verdict={verdict} /> : null}
            </Link>
          ))}
        </nav>
        <div className="console-workspace__body">
          {tab === "workspace" && humanWorkspace && takeover?.session ? <HumanWorkspacePanel runId={id} session={takeover.session} /> : null}
          {tab === "changes" ? (
            <section className="console-section" aria-labelledby="changed">
              <h2 id="changed" className="oq-sr-only">
                What changed
              </h2>
              <Suspense key={target.turn ?? ""} fallback={<SkeletonLines lines={6} />}>
                {target.turn ? <TurnChanges runId={id} taskId={taskId} turn={target.turn} /> : <Changes runId={id} taskId={taskId} />}
              </Suspense>
            </section>
          ) : null}
          {tab === "terminal" ? (
            <Suspense fallback={<SkeletonLines lines={6} />}>
              <TerminalTab runId={id} live={working} />
            </Suspense>
          ) : null}
          {tab === "files" ? (
            <Suspense key={target.path} fallback={<SkeletonLines lines={6} />}>
              <FilesTab runId={id} path={target.path} />
            </Suspense>
          ) : null}
          {tab === "browser" ? (
            <Suspense fallback={<SkeletonLines lines={4} />}>
              <BrowserTab runId={id} />
            </Suspense>
          ) : null}
          {tab === "criteria" ? <CriteriaChecklist runId={id} report={report} /> : null}
          {tab === "evidence" ? <EvidenceTab runId={id} detail={detail} view={view} /> : null}
          {tab === "progress" ? (
            <Suspense fallback={<SkeletonLines lines={6} />}>
              <ProgressTab runId={id} report={report} />
            </Suspense>
          ) : null}
        </div>
      </aside>

      <main className="console-conversation">
        <section className="console-section" aria-labelledby="activity">
          <h2 id="activity" className="console-conversation__label">
            Activity
          </h2>
          <ActivityFeed
            runId={id}
            tail={tailOf(id)}
            head={detail.cursor ?? "0"}
            terminal={detail.terminal}
            working={working}
            parked={parkedOnPerson(report.state)}
          />
        </section>

        <Suspense fallback={null}>
          <GuidanceSent runId={id} />
        </Suspense>

        {guidanceClosed === null ? (
          <section id="guidance" className="console-run__composer" aria-label="Steer this run">
            <Composer runId={id} closedReason={null} />
          </section>
        ) : (
          <p className="console-guidance-rule console-run__closed">{guidanceClosed}</p>
        )}
      </main>
    </div>
  );
}

function EvidenceTab({ runId, detail, view }: { runId: string; detail: RunDetail; view: EvidenceView }) {
  const { report } = detail;
  return (
    <>
      <VerificationSummary runId={runId} report={report} />
      <Suspense
        fallback={
          <section className="console-section" aria-labelledby="risks">
            <h2 id="risks">Needs a look</h2>
            <SkeletonLines lines={1} />
          </section>
        }
      >
        <RisksSection runId={runId} report={report} />
      </Suspense>
      <ModelsPanel config={detail.modelConfig} />
      <Suspense fallback={<SkeletonLines lines={1} />}>
        <KnowledgePanel runId={runId} />
      </Suspense>
      <nav className="oq-tabs oq-tabs--pills" aria-label="Evidence detail">
        {EVIDENCE_VIEWS.map(([key, label]) => (
          <Link key={key} className="oq-tab" aria-current={view === key ? "page" : undefined} href={workspaceHref(runId, "evidence", key)} scroll={false}>
            {label}
            {key === "attempts" && report.repairAttemptsTaken > 0 ? <span className="oq-tab__count">{report.repairAttemptsTaken}</span> : null}
            {key === "verifications" && report.verifications.length > 0 ? <span className="oq-tab__count">{report.verifications.length}</span> : null}
          </Link>
        ))}
      </nav>
      <div aria-label={EVIDENCE_VIEWS.find(([v]) => v === view)?.[1]}>
        {view === "attempts" ? <Attempts report={report} /> : null}
        {view === "cost" ? (
          <Suspense fallback={<SkeletonLines lines={4} />}>
            <CostTab runId={runId} receipt={detail.receipt} />
          </Suspense>
        ) : null}
        {view === "verifications" ? <Verifications runId={runId} report={report} /> : null}
        {view === "provenance" ? <Provenance runId={runId} report={report} candidates={detail.candidates ?? []} /> : null}
      </div>
    </>
  );
}

async function RunLinks({ runId, taskId }: { runId: string; taskId: string }) {
  const [pr, task, openable] = await Promise.all([pullRequestOf(runId, taskId), getTask(taskId), openableTabs()]);
  return (
    <>
      {task ? <SourceBadge task={task} openable={openable} /> : null}
      {task ? <PlaybookBadge playbook={task.playbook} /> : null}
      <span>{pr.repo?.fullName ?? "—"}</span>
      {pr.summary?.prNumber && pr.url ? (
        <a href={pr.url} target="_blank" rel="noreferrer">
          pull request #{pr.summary.prNumber}
        </a>
      ) : null}
    </>
  );
}

function RunSnapshot({ config }: { config: RunDetail["modelConfig"] }) {
  const line = snapshotLine(config);
  if (!line) return null;
  return (
    <span className="console-meta console-run__snapshot" title={line.title} data-snapshot>
      {line.text}
    </span>
  );
}

async function Decision({ runId, detail }: { runId: string; detail: RunDetail }) {
  const { report } = detail;
  const takeover = takeoverOf(detail);
  const reviewable = report.state === "PR_READY" || report.state === "WAITING_FOR_HUMAN";
  const [pr, picker, permitted, merge] = await Promise.all([
    pullRequestOf(runId, report.task.id),
    loadModelPicker(),
    takeover ? holdsTakeover() : Promise.resolve(false),
    reviewable ? getMergeEligibility(runId) : Promise.resolve(null),
  ]);
  const decision = decisionFor({
    state: report.state,
    finalVerdict: report.finalVerdict,
    prNumber: pr.summary?.prNumber ?? null,
    prMergedAt: pr.summary?.prMergedAt ?? null,
    stopReason: report.stopReason,
    stopReasonText: report.stopReasonText,
    criteriaCount: report.task.criteria.length,
    criteriaGeneratedBy: report.task.criteriaGeneratedBy,
    criteriaSatisfied: report.criteria.satisfied,
    hasPullRequest: pr.url !== null,
    merge: mergeFacts(merge),
  }, takeover
    ? {
        enabled: true,
        permitted,
        canStart: canStartSession(takeover),
        session: takeover.session ? { yours: takeover.session.yours, canHandBack: takeover.session.canHandBack, editor: editorName(takeover.session) } : null,
      }
    : undefined);
  return (
    <DecisionCard
      runId={runId}
      taskId={report.task.id}
      title={report.task.title}
      state={report.state}
      decision={decision}
      pullRequestUrl={pr.url}
      picker={picker}
      merge={merge}
    />
  );
}

async function Changes({ runId, taskId }: { runId: string; taskId: string }) {
  const [diff, pr] = await Promise.all([getRunDiff(runId), pullRequestOf(runId, taskId)]);
  if (!("unavailable" in diff)) return <DiffView diff={diff} pullRequestUrl={pr.url} />;
  return (
    <p className="oq-muted" style={{ margin: 0 }}>
      {diff.unavailable}
      {pr.url ? (
        <>
          {" "}
          Read it on <a href={`${pr.url}/files`}>the pull request</a>.
        </>
      ) : null}
    </p>
  );
}

async function TurnChanges({ runId, taskId, turn }: { runId: string; taskId: string; turn: string }) {
  const [newest, pr, steps] = await Promise.all([getRunDiff(runId), pullRequestOf(runId, taskId), getRunAgentEvents(runId).catch(() => null)]);
  const whole = (
    <Link href={workspaceHref(runId, "changes")} scroll={false}>
      Show the whole change
    </Link>
  );
  const say = (text: React.ReactNode) => (
    <p className="oq-muted" style={{ margin: 0 }}>
      {text} {whole}.
    </p>
  );
  if ("unavailable" in newest) return say(newest.unavailable);
  const own = candidateOfTurn(newest, turn);
  const diff = own && own !== newest.candidateSha ? await getRunDiff(runId, own) : newest;
  if ("unavailable" in diff) return say(diff.unavailable);
  if (!steps) return say("Couldn't read this turn's steps, so its files aren't known.");
  const touched = filesTouched(steps, turn);
  if (touched.length === 0) {
    return say(
      steps.length >= AGENT_TAIL
        ? `This turn's edits aren't among the newest ${AGENT_TAIL} steps, so its files aren't known here.`
        : "This turn's steps record no file edits.",
    );
  }
  const scope = scopeToTurn(diff, touched, own !== null);
  return (
    <div className="oq-stack" style={{ ["--gap" as string]: "var(--space-3)" }}>
      <p className="console-guidance-rule">
        Scoped to the {touched.length === 1 ? "file" : `${touched.length} files`} this turn edited, per its steps. A candidate can&rsquo;t be split by turn, so
        {own ? " these are the files as this turn's candidate left them" : " this turn made no candidate of its own; these are the files as the newest candidate has them"}, against the base
        branch: lines an earlier turn wrote in them show too. {whole}.
      </p>
      {scope.notInPatch.length ? (
        <p className="console-guidance-rule">
          Edited, but not in the candidate: <span className="oq-mono">{scope.notInPatch.join(", ")}</span>
        </p>
      ) : null}
      {scope.diff.patch ? (
        <DiffView diff={scope.diff} pullRequestUrl={pr.url} candidateLabel={own ? "this turn's candidate" : "the newest candidate"} />
      ) : (
        <p className="oq-muted" style={{ margin: 0 }}>
          None of the files this turn edited differ from the base branch in that candidate.
        </p>
      )}
    </div>
  );
}

async function TerminalTab({ runId, live }: { runId: string; live: boolean }) {
  const steps = await getRunAgentEvents(runId).catch(() => null);
  if (!steps) {
    return (
      <p className="oq-muted" style={{ margin: 0 }}>
        Couldn&rsquo;t read the agent&rsquo;s steps. Try again in a moment.
      </p>
    );
  }
  return <TerminalLog runId={runId} turns={terminalOf(steps, live)} partial={steps.length >= AGENT_TAIL} />;
}

const ABOUT_THE_PATH = new Set(["not_found", "invalid_path", "path_escapes", "not_a_file", "file_too_large", "binary_file"]);

async function BrowserTab({ runId }: { runId: string }) {
  const shots = await getRunScreenshots(runId);
  if ("unavailable" in shots) {
    return (
      <p className="oq-muted" style={{ margin: 0 }}>
        {shots.unavailable}
      </p>
    );
  }
  return <ScreenshotStrip runId={runId} screenshots={shots} />;
}

async function FilesTab({ runId, path }: { runId: string; path: string }) {
  const first = await getRunWorkspace(runId, path);
  const isFile = "refused" in first ? path !== "" && ABOUT_THE_PATH.has(first.refused.code) : first.kind === "file";
  if (!isFile) return <WorkspaceFiles runId={runId} path={path} listing={first} file={null} />;
  return <WorkspaceFiles runId={runId} path={path} listing={await getRunWorkspace(runId, parentOf(path))} file={first} />;
}

async function ProgressTab({ runId, report }: { runId: string; report: RunReport }) {
  const tail = await tailOf(runId);
  const events = tail && !tail.hasPreviousPage ? tail.items : await getRunTransitions(runId).catch(() => tail?.items ?? []);
  const transitions = events.filter((e) => e.kind === "transition");
  const visited: RunState[] = [...transitions.flatMap((e) => [e.from, e.to]).filter((s): s is RunState => Boolean(s)), report.state];
  return (
    <>
      <StageRail state={report.state} visited={visited} repairs={{ taken: report.repairAttemptsTaken, cap: report.repairCap }} />
      <ProgressScrubber transitions={transitions} now={Date.now()} />
    </>
  );
}

async function GuidanceSent({ runId }: { runId: string }) {
  const guidance = await getRunMessages(runId);
  if (!guidance.items.length) return null;
  return (
    <section className="console-section" aria-labelledby="guidance-sent">
      <h2 id="guidance-sent">Guidance you sent</h2>
      <GuidanceList messages={guidance.items} />
    </section>
  );
}

async function holdsTakeover(): Promise<boolean> {
  try {
    const org = await currentOrganization(await getIdentity());
    return org?.permissions.includes("runs.takeover") ?? false;
  } catch {
    return false;
  }
}

async function CandidateAuthors({ candidates }: { candidates: NonNullable<RunDetail["candidates"]> }) {
  if (candidates.length === 0) return null;
  const viewer = await getIdentity()
    .then((i) => i.principal.githubLogin)
    .catch(() => null);
  return (
    <>
      <dt>Candidates</dt>
      <dd>
        <ol className="console-candidates">
          {candidates.map((c) => (
            <li key={c.sha} data-provenance={c.provenance}>
              <span className="oq-mono">{shortSha(c.sha)}</span> — {provenanceLabel(c, viewer)}
              {c.at ? <span className="console-meta"> · {time(c.at)}</span> : null}
            </li>
          ))}
        </ol>
      </dd>
    </>
  );
}

function Provenance({ runId, report, candidates = [] }: { runId: string; report: RunReport; candidates?: RunDetail["candidates"] }) {
  const record = report.verifications.find((v) => v.verdictOfRecord) ?? null;
  const maker = report.agentRuns.find((a) => a.role === "maker");
  return (
    <dl className="console-kv">
      <dt>Run</dt>
      <dd className="oq-mono">{runId}</dd>
      <dt>Made by</dt>
      <dd>{maker ? `${maker.workerType} · ${maker.model}` : "—"}</dd>
      <CandidateAuthors candidates={candidates} />
      <dt>Checked by</dt>
      <dd>An independent verifier in a separate sandbox</dd>
      <dt>Candidate</dt>
      <dd className="oq-mono">{record ? record.candidateSha : "—"}</dd>
      <dt>Package digest</dt>
      <dd className="oq-mono">{record?.evidence.manifestDigest ?? "—"}</dd>
      <dt>Signature</dt>
      <dd>{report.signed === null ? "not recorded" : report.signed ? "Sigstore" : "not signed"}</dd>
      <dt>Criteria</dt>
      <dd>{report.task.criteriaProvenance === "generated" ? `written by ${report.task.criteriaGeneratedBy ?? "a model"}` : "from the issue"}</dd>
    </dl>
  );
}
