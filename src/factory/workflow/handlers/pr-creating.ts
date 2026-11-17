import type { GitHubClient, RepositoryRef } from "../../../github/client.js";
import {
  NotFoundError,
  PermissionDeniedError,
  RefusedOperationError,
} from "../../../github/client.js";
import { checkRunFor, findStickyComment, renderEvidenceSummary } from "../../../github/summary.js";
import { assembleRunReport } from "../../run-report.js";
import { listMakerScreenshots } from "../../maker-screenshots.js";
import {
  findMakerScreenshotsComment,
  renderMakerScreenshotsComment,
} from "../../../github/maker-screenshots-comment.js";
import type { RunReport } from "../../run-report.js";
import {
  type EngineeringTask,
  getEngineeringRun,
  getEngineeringTask,
  updateEngineeringRun,
  updateEngineeringTask,
} from "../../repositories.js";
import { getRepository, type Repository } from "../../repository-entity.js";
import { measureHumanCommits, type HumanCommitCount } from "../../human-rework.js";
import { issueNumberOf, runBranchFor } from "../branch.js";
import type { StageContext, StageHandler, StageOutcome } from "../provider.js";
import type { StageDeps } from "../stage-deps.js";
import { makeChangesRequested } from "./human-editing.js";

interface RunContext {
  report: RunReport;
  task: EngineeringTask;
  repository: Repository;
  ref: RepositoryRef;
  issueNumber: number | null;
  branch: string;
  github: GitHubClient;
}

async function contextFor(
  deps: StageDeps,
  engineeringRunId: string,
): Promise<RunContext | { unavailable: string }> {
  if (!deps.github) {
    return { unavailable: "no GitHub client is configured in this worker (GITHUB_APP_ID unset)" };
  }
  const run = await getEngineeringRun(deps.pool, engineeringRunId);
  if (!run) throw new Error(`pr: engineering_run ${engineeringRunId} not found`);
  const task = await getEngineeringTask(deps.pool, run.taskId);
  if (!task) throw new Error(`pr: engineering_task for run ${engineeringRunId} not found`);

  const repository = await getRepository(deps.pool, task.repositoryId);
  if (!repository) {
    return { unavailable: `task ${task.id} has no repository row (ADR-0018)` };
  }
  const report = await assembleRunReport(deps.pool, engineeringRunId);
  return {
    report,
    task,
    repository,
    ref: { owner: repository.owner, name: repository.name },
    issueNumber: issueNumberOf(task),
    branch: runBranchFor(engineeringRunId, task),
    github: deps.github,
  };
}

function failedFor(error: unknown): StageOutcome {
  const reason =
    error instanceof PermissionDeniedError
      ? `the installation cannot ${error.permission ?? "act on"} ${error.resource} — ` +
        "the App's permissions changed mid-run (ADR-0009 §6)"
      : error instanceof NotFoundError
        ? `${error.resource} is gone — the branch or repository the run was working against no ` +
          "longer exists"
        : error instanceof RefusedOperationError
          ? error.message
          : `the pull request surface could not be published: ${
              error instanceof Error ? error.message : String(error)
            }`;
  return { kind: "transition", to: "FAILED", reason, stopReason: "error" };
}

function createPrCreatingHandler(deps: StageDeps): StageHandler {
  return {
    state: "PR_CREATING",
    name: "pr:create",
    async handle(context: StageContext): Promise<StageOutcome> {
      const resolved = await contextFor(deps, context.engineeringRunId);
      if ("unavailable" in resolved) {
        return {
          kind: "transition",
          to: "FAILED",
          reason: `cannot open a pull request: ${resolved.unavailable}`,
          stopReason: "error",
        };
      }
      try {
        return await publish(deps, context.engineeringRunId, resolved);
      } catch (error) {
        return failedFor(error);
      }
    },
  };
}

async function publish(
  deps: StageDeps,
  engineeringRunId: string,
  ctx: RunContext,
): Promise<StageOutcome> {
  const { github, ref, report } = ctx;

  const verified = report.verifications.find((v) => v.verdictOfRecord)?.candidateSha ?? null;
  if (!verified) {
    return {
      kind: "transition",
      to: "FAILED",
      reason: "cannot open a pull request: the run has no verified candidate on record",
      stopReason: "error",
    };
  }
  const head = await github.getBranchHead(ref, ctx.branch);
  if (head !== verified) {
    return headMoved(ctx.branch, verified, head);
  }

  const existing = (await github.listPullRequests({ repository: ref, headRef: ctx.branch }))[0];
  if (existing && existing.headSha !== verified) {
    return headMoved(ctx.branch, verified, existing.headSha, existing.number);
  }
  const pull =
    existing ??
    (await github.createPullRequest({
      repository: ref,
      headRef: ctx.branch,
      baseRef: ctx.repository.defaultBranch,
      title: prTitle(ctx.task),
      body: prBody(report, ctx),
    }));
  if (!existing && pull.headSha !== verified) {
    await updateEngineeringRun(deps.pool, engineeringRunId, { prNumber: pull.number });
    return headMoved(ctx.branch, verified, pull.headSha, pull.number);
  }

  await updateEngineeringRun(deps.pool, engineeringRunId, { prNumber: pull.number });

  await publishCheckRun(ctx);
  await upsertStickyComment(ctx, pull.number);
  await upsertMakerScreenshotsComment(deps, ctx, pull.number).catch((error: unknown) => {
    console.warn(
      `maker screenshots comment on #${pull.number} was not published: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  return {
    kind: "transition",
    to: "PR_READY",
    reason: `${existing ? "adopted" : "opened"} draft pull request #${pull.number} for ${ctx.branch}`,
  };
}

function headMoved(branch: string, verified: string, head: string | null, pullNumber?: number): StageOutcome {
  return {
    kind: "transition",
    to: "FAILED",
    reason:
      (head === null
        ? `${branch} does not exist on the remote, so there is no verified commit to open a pull request from`
        : `${branch} is at ${head}, not at ${verified}, the commit verification judged — the branch ` +
          "moved after verification, and no evidence describes the commit it holds now") +
      (pullNumber !== undefined
        ? `. Draft pull request #${pullNumber} carries that unverified head; no check run or ` +
          `evidence comment was published on it, and any summary in its body describes ${verified}, ` +
          "not its head"
        : "; no pull request was opened") +
      ". Start a new run to verify what the branch holds.",
    stopReason: "error",
  };
}

async function publishCheckRun(ctx: RunContext): Promise<void> {
  const payload = checkRunFor(ctx.report);
  if (!payload.headSha) return;

  const existing = (await ctx.github.listCheckRuns(ctx.ref, payload.headSha)).find(
    (run) => run.name === payload.name,
  );
  if (existing) {
    await ctx.github.updateCheckRun({
      repository: ctx.ref,
      checkRunId: existing.id,
      status: payload.status,
      ...(payload.conclusion ? { conclusion: payload.conclusion } : {}),
      ...(payload.output ? { output: payload.output } : {}),
    });
    return;
  }
  await ctx.github.createCheckRun({
    repository: ctx.ref,
    headSha: payload.headSha,
    name: payload.name,
    status: payload.status,
    ...(payload.conclusion ? { conclusion: payload.conclusion } : {}),
    ...(payload.output ? { output: payload.output } : {}),
  });
}

async function upsertStickyComment(ctx: RunContext, pullNumber: number): Promise<void> {
  const body = renderEvidenceSummary(ctx.report);
  const comments = await ctx.github.listIssueComments(ctx.ref, pullNumber);
  const sticky = findStickyComment(comments, ctx.report.engineeringRunId);
  if (sticky) {
    await ctx.github.updateIssueComment(ctx.ref, sticky.id, body);
    return;
  }
  await ctx.github.createIssueComment(ctx.ref, pullNumber, body);
}

async function upsertMakerScreenshotsComment(deps: StageDeps, ctx: RunContext, pullNumber: number): Promise<void> {
  const screenshots = await listMakerScreenshots(deps.pool, ctx.report.engineeringRunId);
  if (screenshots.length === 0) return;
  const consoleUrl = process.env["WINDKEEL_CONSOLE_URL"]?.trim().replace(/\/+$/, "");
  const body = renderMakerScreenshotsComment(
    ctx.report.engineeringRunId,
    screenshots,
    consoleUrl ? `${consoleUrl}/runs/${ctx.report.engineeringRunId}?tab=browser` : null,
  );
  const comments = await ctx.github.listIssueComments(ctx.ref, pullNumber);
  const existing = findMakerScreenshotsComment(comments, ctx.report.engineeringRunId);
  if (existing) {
    if (existing.body !== body) await ctx.github.updateIssueComment(ctx.ref, existing.id, body);
    return;
  }
  await ctx.github.createIssueComment(ctx.ref, pullNumber, body);
}

function prTitle(task: EngineeringTask): string {
  const title = task.title.replace(/\s+/g, " ").trim();
  return title.length > 72 ? `${title.slice(0, 71)}…` : title;
}

function prBody(report: RunReport, ctx: RunContext): string {
  const resolves = ctx.issueNumber === null ? "" : `\n\nResolves #${ctx.issueNumber}`;
  return `${renderEvidenceSummary(report)}${resolves}`;
}

function createPrReadyHandler(deps: StageDeps): StageHandler {
  return {
    state: "PR_READY",
    name: "pr:ready",
    async handle(context: StageContext): Promise<StageOutcome> {
      const resolved = await contextFor(deps, context.engineeringRunId);
      if ("unavailable" in resolved) {
        return {
          kind: "transition",
          to: "WAITING_FOR_HUMAN",
          reason: `pull request open; issue not notified (${resolved.unavailable})`,
        };
      }
      const run = await getEngineeringRun(deps.pool, context.engineeringRunId);
      const prNumber = run?.prNumber ?? null;

      if (resolved.issueNumber !== null && prNumber !== null) {
        try {
          await resolved.github.createIssueComment(
            resolved.ref,
            resolved.issueNumber,
            `**Draft pull request #${prNumber} is open** with the evidence summary attached. ` +
              `Windkeel does not mark it ready for review, approve, or merge — that is yours ` +
              `(ADR-0009 §5).`,
          );
        } catch (error) {
          return failedFor(error);
        }
      }

      await updateEngineeringTask(deps.pool, resolved.task.id, { status: "WAITING_FOR_HUMAN" });
      return {
        kind: "transition",
        to: "WAITING_FOR_HUMAN",
        reason: prNumber === null ? "no pull request recorded" : `pull request #${prNumber} awaits a human`,
      };
    },
  };
}

async function humanCommitsFor(
  deps: StageDeps,
  task: EngineeringTask | null,
  pullNumber: number,
): Promise<HumanCommitCount> {
  if (!deps.github) {
    return { kind: "unknown", reason: "this worker has no GitHub client (ADR-0016 hermetic mode)" };
  }
  if (!task) return { kind: "unknown", reason: "the run has no task row" };
  const repository = await getRepository(deps.pool, task.repositoryId);
  if (!repository) {
    return { kind: "unknown", reason: `task ${task.id} has no repository row (ADR-0018)` };
  }
  return measureHumanCommits(
    deps.github,
    { owner: repository.owner, name: repository.name },
    pullNumber,
    { authorEmail: deps.config.gitAuthorEmail },
  );
}

const PR_CLOSED_SIGNAL = "pull_request.closed";

export interface PullRequestClosedPayload {
  merged: boolean;
  pullNumber: number;
  mergedAt?: string | null;
}

export function createWaitingForHumanHandler(deps: StageDeps): StageHandler {
  return {
    state: "WAITING_FOR_HUMAN",
    name: "pr:await-human",
    async handle(context: StageContext): Promise<StageOutcome> {
      if (await context.isCancellationRequested()) {
        return { kind: "settled", observed: context.state, note: "cancellation observed" };
      }
      const signals = await context.takeSignals();
      const closed = signals.find(
        (s) => s.signal.type === "external_event" && s.signal.name === PR_CLOSED_SIGNAL,
      );
      if (!closed || closed.signal.type !== "external_event") {
        const makeChanges = await makeChangesRequested(deps, context.engineeringRunId);
        if (makeChanges) return makeChanges;
        return { kind: "wait", reason: "the pull request is open; waiting for a human" };
      }

      const payload = (closed.signal.payload ?? {}) as PullRequestClosedPayload;
      const run = await getEngineeringRun(deps.pool, context.engineeringRunId);
      const task = run ? await getEngineeringTask(deps.pool, run.taskId) : null;

      if (payload.merged) {
        const measured = await humanCommitsFor(deps, task, payload.pullNumber);

        await updateEngineeringRun(deps.pool, context.engineeringRunId, {
          prMergedAt: payload.mergedAt ? new Date(payload.mergedAt) : new Date(closed.receivedAt),
          ...(payload.pullNumber ? { prNumber: payload.pullNumber } : {}),
          humanCommitsAfterPr: measured.kind === "counted" ? measured.count : null,
        });
        if (task) await updateEngineeringTask(deps.pool, task.id, { status: "COMPLETED" });
        return {
          kind: "transition",
          to: "COMPLETED",
          reason:
            `pull request #${payload.pullNumber} was merged` +
            (measured.kind === "counted"
              ? `; ${measured.count} human commit${measured.count === 1 ? "" : "s"} after it opened`
              : `; human commits after it opened are unknown — ${measured.reason}`),
        };
      }

      if (task) await updateEngineeringTask(deps.pool, task.id, { status: "CANCELLED" });
      return {
        kind: "transition",
        to: "CANCELLED",
        reason: `pull request #${payload.pullNumber} was closed without merging`,
      };
    },
  };
}

export function createPullRequestHandlers(deps: StageDeps): StageHandler[] {
  return [
    createPrCreatingHandler(deps),
    createPrReadyHandler(deps),
    createWaitingForHumanHandler(deps),
  ];
}
