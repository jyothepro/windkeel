import { eventsCounted, recordAgentEvents } from "../../agent-events.js";
import { listWorkspaces } from "../../repositories.js";
import {
  claimPendingGuidance,
  markGuidanceDelivered,
  markGuidanceUndeliverable,
  renderGuidance,
} from "../../run-guidance.js";
import { acquireWorkspaceHandle } from "./attach-workspace.js";
import { pendingTakeover } from "../../human-session.js";
import { saveSessionBinding } from "../session-binding.js";
import { teardownWorkspace } from "../../workspace-service.js";
import type { WorkerEvent, WorkerResult, WorkerSession } from "../../../worker/adapter.js";
import { enforceSpendAndTimeRails } from "../rails-gate.js";
import type { StageContext, StageOutcome } from "../provider.js";
import type { MakerStageDeps, StageDeps } from "../stage-deps.js";
import type { CandidateCapture } from "./candidate-capture.js";
import { loadSessionProgress, saveSessionProgress } from "./session-progress.js";
import { harvestMakerScreenshots } from "../../maker-screenshots.js";

export interface AgentSessionSummary {
  eventCounts: Record<string, number>;
  tests: Array<{ command: string; exitCode: number | null; passed: boolean }>;
  filesChanged: string[];
  outcome: WorkerResult["outcome"];
  error?: string;
  finalMessage?: string;
  truncatedDiff: boolean;
  candidate?: CandidateCapture;
  selfReportDivergence?: WorkerResult["selfReportDivergence"];
  stoppedBy?: "spend_cap" | "wall_clock_cap" | "cancellation";
}

export const DEFAULT_SESSION_POLL_INTERVAL_MS = 60_000;

export interface SessionPollOptions {
  beforeTeardown?: (() => Promise<void>) | undefined;
}

export interface SessionPoll {
  finished: boolean;
  summary: AgentSessionSummary;
  polls: number;
}

export async function pollSession(
  deps: MakerStageDeps,
  context: StageContext,
  session: WorkerSession,
  agentRunId: string,
  options: SessionPollOptions = {},
): Promise<SessionPoll> {
  const { pool } = deps;

  const loaded = await loadSessionProgress(pool, agentRunId);
  if (loaded?.turnEndedAt) {
    return { finished: true, summary: loaded.summary, polls: loaded.polls };
  }
  const summary: AgentSessionSummary = loaded?.summary ?? emptySessionSummary();
  const changed = new Set<string>(summary.filesChanged);
  const polls = (loaded?.polls ?? 0) + 1;

  const read = await readAvailable(deps, session);

  await recordAgentEvents(pool, context.engineeringRunId, agentRunId, eventsCounted(summary.eventCounts), read.events).catch(
    (err: unknown) => {
      console.warn(`agent events for run ${context.engineeringRunId} were not recorded: ${err instanceof Error ? err.message : String(err)}`);
    },
  );

  for (const event of read.events) record(summary, changed, event);
  let turnEnded = read.turnEnded;

  summary.filesChanged = [...changed].sort();

  if (!summary.stoppedBy) {
    const rails = await enforceSpendAndTimeRails(pool, context.engineeringRunId, new Date(), { organizationBudget: true });
    if (rails.stopped) {
      summary.stoppedBy = rails.reason === "wall_clock_cap" ? "wall_clock_cap" : "spend_cap";
    } else if (await context.isCancellationRequested()) {
      summary.stoppedBy = "cancellation";
    }
    if (summary.stoppedBy) {
      await stopSession(deps, context, session, options.beforeTeardown, agentRunId);
      turnEnded = true;
    }
  }

  if (turnEnded && !summary.stoppedBy) await harvestScreenshots(deps, context.engineeringRunId, agentRunId);

  const takingOver = turnEnded && !summary.stoppedBy && (await pendingTakeover(pool, context.engineeringRunId)) !== null;
  if (turnEnded && !summary.stoppedBy && !takingOver) {
    const sent = await deliverPendingGuidance(deps, context.engineeringRunId, session);
    if (sent > 0) turnEnded = false;
  }

  await recordSessionBinding(deps, context.engineeringRunId, session);

  await saveSessionProgress(pool, {
    agentRunId,
    engineeringRunId: context.engineeringRunId,
    summary,
    sessionRef: referenceOrNull(deps, session),
    polls,
    turnEnded,
  });

  return { finished: turnEnded, summary, polls };
}

async function deliverPendingGuidance(
  deps: MakerStageDeps,
  engineeringRunId: string,
  session: WorkerSession,
): Promise<number> {
  const { pool, worker } = deps;
  const claimed = await claimPendingGuidance(pool, engineeringRunId);
  if (claimed.length === 0) return 0;

  const ids = claimed.map((item) => item.id);

  if (!worker.capabilities.resumableSessions) {
    await markGuidanceUndeliverable(
      pool,
      ids,
      `the "${worker.name}" worker cannot resume a session (capabilities.resumableSessions is ` +
        "false), so there is no turn to carry guidance. Cancel the run and submit a new task with " +
        "the guidance in its description.",
    );
    return 0;
  }

  try {
    await worker.send(session, { text: renderGuidance(claimed) });
  } catch (err) {
    await markGuidanceUndeliverable(
      pool,
      ids,
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }

  await markGuidanceDelivered(pool, ids);
  return claimed.length;
}

async function readAvailable(
  deps: MakerStageDeps,
  session: WorkerSession,
): Promise<{ events: WorkerEvent[]; turnEnded: boolean }> {
  const { worker } = deps;
  if (typeof worker.poll === "function") return worker.poll(session);
  const events: WorkerEvent[] = [];
  for await (const event of worker.events(session)) events.push(event);
  return { events, turnEnded: true };
}

const LIVE_WORKSPACE_STATUSES = new Set(["ready", "provisioning"]);

async function stopSession(
  deps: MakerStageDeps,
  context: StageContext,
  session: WorkerSession,
  beforeTeardown?: (() => Promise<void>) | undefined,
  agentRunId?: string,
): Promise<void> {
  const { worker } = deps;
  await worker.cancel(session).catch(() => {});

  if (agentRunId) await harvestScreenshots(deps, context.engineeringRunId, agentRunId);

  if (beforeTeardown) await beforeTeardown().catch(() => {});

  const { pool, registry } = deps;
  const workspaces = await listWorkspaces(pool, context.engineeringRunId);
  for (const workspace of workspaces) {
    if (!LIVE_WORKSPACE_STATUSES.has(workspace.status)) continue;
    const handle = await acquireWorkspaceHandle(deps, workspace);
    if (!handle) continue;
    await teardownWorkspace(
      pool,
      handle,
      workspace.id,
      context.engineeringRunId,
      deps.config.usdPerCpuMs,
      deps.config.usdPerEgressByte,
    ).catch(() => {});
    registry.forget(workspace.id);
  }
}

export async function recordSessionBinding(
  deps: Pick<MakerStageDeps, "pool" | "worker">,
  engineeringRunId: string,
  session: WorkerSession,
): Promise<void> {
  const { worker } = deps;
  if (!worker.capabilities.reattachableSessions) return;
  let ref;
  try {
    ref = worker.reference(session);
  } catch {
    return;
  }
  await saveSessionBinding(deps.pool, engineeringRunId, {
    workerType: worker.name,
    sessionRef: ref,
    resumable: worker.capabilities.resumableSessions,
  });
}

async function harvestScreenshots(deps: StageDeps, engineeringRunId: string, agentRunId: string): Promise<void> {
  if (deps.config.makerBrowser === false || !deps.evidence) return;
  try {
    const maker = (await listWorkspaces(deps.pool, engineeringRunId)).find(
      (w) => w.role === "maker" && LIVE_WORKSPACE_STATUSES.has(w.status),
    );
    if (!maker) return;
    const handle = await acquireWorkspaceHandle(deps, maker);
    if (!handle) return;
    const harvested = await harvestMakerScreenshots(deps.pool, {
      handle,
      engineeringRunId,
      agentRunId,
      storage: deps.evidence,
      max: deps.config.makerScreenshotMax,
    });
    if (harvested.dropped.length) {
      console.warn(
        `maker screenshots for run ${engineeringRunId}: dropped ${harvested.dropped.length} file(s) — ` +
          harvested.dropped.slice(0, 5).map((d) => `${JSON.stringify(d.path)} (${d.reason})`).join(", "),
      );
    }
  } catch (err) {
    console.warn(`maker screenshots for run ${engineeringRunId} were not harvested: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function emptySessionSummary(): AgentSessionSummary {
  return { eventCounts: {}, tests: [], filesChanged: [], outcome: "completed", truncatedDiff: false };
}

export function referenceOrNull(deps: Pick<MakerStageDeps, "worker">, session: WorkerSession): Record<string, unknown> | null {
  const { worker } = deps;
  if (!worker.capabilities.reattachableSessions) return null;
  try {
    return worker.reference(session) as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function pollOutcome(deps: StageDeps): StageOutcome {
  return {
    kind: "poll",
    afterMs: deps.config.railsCheckIntervalMs,
    reason: "the agent session is still running; rails are re-checked on every poll",
  };
}

function record(summary: AgentSessionSummary, changed: Set<string>, event: WorkerEvent): void {
  summary.eventCounts[event.type] = (summary.eventCounts[event.type] ?? 0) + 1;
  if (event.type === "test_finished") {
    summary.tests.push({ command: event.command, exitCode: event.exitCode, passed: event.passed });
  }
  if (event.type === "file_changed") changed.add(event.path);
  if (event.type === "message") summary.finalMessage = event.text;
  if (event.type === "failed") summary.error = event.error;
}
