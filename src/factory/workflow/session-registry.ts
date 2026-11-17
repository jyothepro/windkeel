import type { SandboxHandle } from "../../sandbox/provider.js";
import type { WorkerSession } from "../../worker/adapter.js";
import type { StageOutcome } from "./provider.js";
import { loadSessionBinding } from "./session-binding.js";
import type { MakerStageDeps } from "./stage-deps.js";

export interface HeldSession {
  readonly session: WorkerSession;
  readonly workerType: string;
  readonly resumable: boolean;
}

export class WorkerSessionRegistry {
  private readonly byRunId = new Map<string, HeldSession>();

  put(engineeringRunId: string, held: HeldSession): void {
    this.byRunId.set(engineeringRunId, held);
  }

  get(engineeringRunId: string): HeldSession | undefined {
    return this.byRunId.get(engineeringRunId);
  }

  forget(engineeringRunId: string): void {
    this.byRunId.delete(engineeringRunId);
  }

  get size(): number {
    return this.byRunId.size;
  }
}

export type SessionUnavailableReason =
  | "session_unreachable"
  | "worker_not_resumable"
  | "worker_changed";

export interface SessionResolution {
  held?: HeldSession;
  reason?: SessionUnavailableReason;
  outcome?: StageOutcome;
}

export async function resolveRepairSession(
  deps: Pick<MakerStageDeps, "pool" | "worker" | "sessions">,
  engineeringRunId: string,
  maker: SandboxHandle | undefined,
): Promise<SessionResolution> {
  const { pool, worker, sessions } = deps;
  const held = sessions.get(engineeringRunId) ?? (await reattach(deps, engineeringRunId, maker));
  if (!held) {
    const binding = await loadSessionBinding(pool, engineeringRunId);
    return {
      reason: "session_unreachable",
      outcome: {
        kind: "transition",
        to: "FAILED",
        reason:
          "the worker session that produced the candidate cannot be resumed. " +
          (binding
            ? maker
              ? `a durable reference exists but the "${worker.name}" adapter could not attach ` +
                "to it — the sandbox holding the session is gone, or the reference no longer " +
                "describes a session it can use"
              : "the maker workspace the session lives inside could not be re-acquired, so " +
                "there is nothing to attach to"
            : "no durable session reference was recorded for this run " +
              `(the "${worker.name}" adapter reports reattachableSessions: ` +
              `${worker.capabilities.reattachableSessions})`) +
          ". ADR-0011 §2 requires a resumed turn, and a cold turn is not one " +
          "(session_unreachable).",
        stopReason: "error",
      },
    };
  }
  if (held.workerType !== worker.name) {
    return {
      reason: "worker_changed",
      outcome: {
        kind: "transition",
        to: "FAILED",
        reason:
          `the session was started by "${held.workerType}" and this process runs ` +
          `"${worker.name}"; ADR-0011 §2 forbids changing the worker between attempts ` +
          "(worker_changed).",
        stopReason: "error",
      },
    };
  }
  if (!held.resumable || !worker.capabilities.resumableSessions) {
    return {
      reason: "worker_not_resumable",
      outcome: {
        kind: "transition",
        to: "FAILED",
        reason:
          `the "${worker.name}" adapter reports resumableSessions: false, so the repair turn ` +
          "ADR-0011 §2 specifies cannot be taken at all (worker_not_resumable).",
        stopReason: "error",
      },
    };
  }
  return { held };
}

async function reattach(
  deps: Pick<MakerStageDeps, "pool" | "worker" | "sessions">,
  engineeringRunId: string,
  maker: SandboxHandle | undefined,
): Promise<HeldSession | undefined> {
  const { pool, worker, sessions } = deps;
  if (!maker || !worker.capabilities.reattachableSessions) return undefined;
  const binding = await loadSessionBinding(pool, engineeringRunId);
  if (!binding || binding.workerType !== worker.name) return undefined;
  try {
    const session = await worker.attach(binding.sessionRef, maker);
    const held: HeldSession = {
      session,
      workerType: binding.workerType,
      resumable: binding.resumable,
    };
    sessions.put(engineeringRunId, held);
    return held;
  } catch {
    return undefined;
  }
}
