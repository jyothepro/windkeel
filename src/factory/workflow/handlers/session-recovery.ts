import type { SandboxHandle } from "../../../sandbox/provider.js";
import {
  WorkerSessionGoneError,
  type WorkerSession,
  type WorkerSessionRef,
} from "../../../worker/adapter.js";
import { listWorkspaces } from "../../repositories.js";
import type { StageOutcome } from "../provider.js";
import { saveSessionBinding } from "../session-binding.js";
import type { MakerStageDeps, StageDeps } from "../stage-deps.js";
import { makerWorkspaceOf } from "./maker-workspace.js";
import { saveSessionProgress, type SessionProgress } from "./session-progress.js";
import { emptySessionSummary, referenceOrNull } from "./session-turn.js";
import { withTransaction } from "../../db/transaction.js";

export type Reacquired =
  | { session: WorkerSession; outcome?: undefined }
  | { session?: undefined; outcome: StageOutcome };

export async function reacquireSession(
  deps: Pick<MakerStageDeps, "worker" | "sessions">,
  engineeringRunId: string,
  agentRunId: string,
  inFlight: SessionProgress,
  handle: SandboxHandle,
): Promise<Reacquired> {
  const { worker } = deps;
  const held = deps.sessions.get(engineeringRunId)?.session;
  if (held) return { session: held };

  if (!worker.capabilities.reattachableSessions) {
    return failed(
      `agent session for ${agentRunId} is in flight but cannot be re-acquired in this ` +
        `process: the "${worker.name}" adapter reports reattachableSessions: false` +
        (inFlight.sessionRef ? "" : " and no session reference was persisted") +
        ".",
    );
  }

  if (!inFlight.sessionRef) {
    return failed(
      `an agent for session ${agentRunId} was being launched when the delivery launching it ` +
        "stopped, and no session reference was recorded — so whether an agent is running in the " +
        "checkout is unknown, and there is nothing to reattach to. Launching another could put " +
        "two agents in one checkout (ADR-0007 §4), so the run stops here; releasing the sandbox " +
        "also stops any agent that did start.",
    );
  }

  try {
    return {
      session: await worker.attach(inFlight.sessionRef as unknown as WorkerSessionRef, handle),
    };
  } catch (error) {
    if (!(error instanceof WorkerSessionGoneError)) throw error;
    return failed(
      `${error.message}. The checkout may still hold the agent's uncommitted edits, but without ` +
        "its session there is no turn to finish and no output to account for, and a fresh agent " +
        "on that checkout would be a second agent on one attempt (ADR-0007 §4, ADR-0017 §3). " +
        "No new agent was started.",
    );
  }
}

export async function recordLaunchedSession(
  deps: Pick<MakerStageDeps, "pool" | "worker">,
  engineeringRunId: string,
  agentRunId: string,
  session: WorkerSession,
): Promise<void> {
  const { worker } = deps;
  const ref = referenceOrNull(deps, session);
  if (!ref) return;
  await withTransaction(deps.pool, async (client) => {
    await saveSessionBinding(client, engineeringRunId, {
      workerType: worker.name,
      sessionRef: ref as unknown as WorkerSessionRef,
      resumable: worker.capabilities.resumableSessions,
    });
    await saveSessionProgress(client, {
      agentRunId,
      engineeringRunId,
      summary: emptySessionSummary(),
      sessionRef: ref,
      polls: 0,
    });
  });
}

export async function makerReleased(
  deps: Pick<StageDeps, "pool">,
  engineeringRunId: string,
): Promise<boolean> {
  try {
    const workspaces = await listWorkspaces(deps.pool, engineeringRunId);
    return workspaces.some((w) => w.role === "maker") && !makerWorkspaceOf(workspaces);
  } catch {
    return false;
  }
}

export function thrownStageReason(stage: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    `${stage} failed: ${message}. The maker sandbox was released when the stage failed, so a ` +
    "retry would have nothing to resume."
  );
}

function failed(reason: string): Reacquired {
  return { outcome: { kind: "transition", to: "FAILED", reason, stopReason: "error" } };
}
