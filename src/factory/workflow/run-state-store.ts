import type { Pool } from "pg";
import type { StopReason } from "../rails.js";
import { getEngineeringRun, getLastTransitionInto } from "../repositories.js";
import { advanceRun } from "../run-service.js";
import type { RunState } from "../run-state-machine.js";
import { UnknownRunError, type RunStateSnapshot, type RunStateStore } from "./provider.js";

export class PostgresRunStateStore implements RunStateStore {
  constructor(private readonly pool: Pool) {}

  async read(engineeringRunId: string): Promise<RunStateSnapshot | null> {
    const run = await getEngineeringRun(this.pool, engineeringRunId);
    if (!run) return null;
    let blockedFrom: RunState | null = null;
    if (run.status === "BLOCKED") {
      const last = await getLastTransitionInto(this.pool, engineeringRunId, "BLOCKED");
      blockedFrom = last?.fromState ?? null;
    }
    return { state: run.status, blockedFrom, stopReason: run.stopReason };
  }

  async commit(
    engineeringRunId: string,
    to: RunState,
    reason: string | null,
    stopReason?: StopReason | null,
  ): Promise<RunStateSnapshot> {
    await advanceRun(
      this.pool,
      engineeringRunId,
      to,
      reason,
      stopReason === undefined ? {} : { stopReason },
    );
    const snapshot = await this.read(engineeringRunId);
    if (!snapshot) throw new UnknownRunError(engineeringRunId);
    return snapshot;
  }
}
