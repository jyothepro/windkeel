import type { Pool, PoolClient } from "pg";
import { deleteSessionProgress, selectSessionProgressRow, upsertSessionProgress } from "../stores/session-store.js";
import type { AgentSessionSummary } from "./session-turn.js";

type Queryable = Pool | PoolClient;

export interface SessionProgress {
  readonly summary: AgentSessionSummary;
  readonly sessionRef: Record<string, unknown> | null;
  readonly polls: number;
  readonly turnEndedAt: Date | null;
}

export interface SaveSessionProgress extends Omit<SessionProgress, "turnEndedAt"> {
  readonly agentRunId: string;
  readonly engineeringRunId: string;
  readonly turnEnded?: boolean;
}

export async function loadSessionProgress(
  pool: Pool,
  agentRunId: string,
): Promise<SessionProgress | null> {
  const row = await selectSessionProgressRow(pool, agentRunId);
  if (!row) return null;
  return {
    summary: row["summary"] as AgentSessionSummary,
    sessionRef: (row["session_ref"] as Record<string, unknown> | null) ?? null,
    polls: row["polls"] as number,
    turnEndedAt: (row["turn_ended_at"] as Date | null) ?? null,
  };
}

export async function saveSessionProgress(db: Queryable, progress: SaveSessionProgress): Promise<void> {
  await upsertSessionProgress(db, {
    agentRunId: progress.agentRunId,
    engineeringRunId: progress.engineeringRunId,
    summaryJson: JSON.stringify(progress.summary),
    sessionRefJson: progress.sessionRef === null ? null : JSON.stringify(progress.sessionRef),
    polls: progress.polls,
    turnEnded: progress.turnEnded === true,
  });
}

export async function clearSessionProgress(pool: Pool, agentRunId: string): Promise<void> {
  await deleteSessionProgress(pool, agentRunId);
}
