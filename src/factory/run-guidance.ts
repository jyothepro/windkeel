

import type { Pool, PoolClient } from "pg";
import { TERMINAL_STATES, type RunState } from "./run-state-machine.js";
import { withTransaction } from "./db/transaction.js";
import { lockEngineeringRunRow } from "./stores/run-store.js";
import {
  bumpPendingGuidanceRows,
  giveUpExhaustedGuidance,
  insertGuidanceRow,
  markGuidanceRowsDelivered,
  markGuidanceRowsUndeliverable,
  selectGuidanceRows,
} from "./stores/guidance-store.js";

type Db = Pool | PoolClient;

export type GuidanceState = "queued" | "delivered" | "undeliverable" | "superseded";

export interface GuidanceRecord {
  id: string;
  cursor: string;
  at: Date;
  actor: string;
  message: string;
  state: GuidanceState;
  deliveredAt: Date | null;

  undeliverableReason: string | null;
  deliveryAttempts: number;
}

export interface ClaimedGuidance {
  id: string;
  actor: string;
  message: string;
}

export async function recordGuidance(
  db: Db,
  input: { engineeringRunId: string; actor: string; actorPrincipalId?: string | null | undefined; message: string },
): Promise<GuidanceRecord> {
  const row = await insertGuidanceRow(db, {
    engineeringRunId: input.engineeringRunId,
    actor: input.actor,
    message: input.message,
    actorPrincipalId: input.actorPrincipalId ?? null,
  });

  return mapRow(row, false);
}

export async function listGuidance(
  db: Db,
  engineeringRunId: string,
  runState: RunState | string,
): Promise<GuidanceRecord[]> {
  const rows = await selectGuidanceRows(db, engineeringRunId);
  const terminal = TERMINAL_STATES.has(runState as RunState);
  return rows.map((row) => mapRow(row, terminal));
}

export const MAX_DELIVERY_ATTEMPTS = 3;

export async function claimPendingGuidance(
  pool: Pool,
  engineeringRunId: string,
): Promise<ClaimedGuidance[]> {
  const rows = await withTransaction(pool, async (client) => {
    await lockEngineeringRunRow(client, engineeringRunId);

    await giveUpExhaustedGuidance(client, engineeringRunId, MAX_DELIVERY_ATTEMPTS);
    return bumpPendingGuidanceRows(client, engineeringRunId);
  });

  return rows
    .sort((a, b) => (BigInt(a["seq"] as string) < BigInt(b["seq"] as string) ? -1 : 1))
    .map((row) => ({
      id: row["id"] as string,
      actor: row["actor"] as string,
      message: row["message"] as string,
    }));
}

export async function markGuidanceDelivered(db: Db, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await markGuidanceRowsDelivered(db, ids);
}

export async function markGuidanceUndeliverable(
  db: Db,
  ids: readonly string[],
  reason: string,
): Promise<void> {
  if (ids.length === 0) return;
  await markGuidanceRowsUndeliverable(db, ids, reason);
}

export const GUIDANCE_PREAMBLE =
  "The following is guidance from the human operator watching this run. It is binding on *how* " +
  "you do the work. It does not change *what* the task is: the acceptance criteria you were " +
  "given are unchanged and are still what this work will be judged against. If the guidance " +
  "would require changing those criteria, say so in your next message and do not act on it.";

export function renderGuidance(items: readonly ClaimedGuidance[]): string {
  const body = items.map((item) => `${item.actor} said:\n${item.message}`).join("\n\n---\n\n");
  return `${GUIDANCE_PREAMBLE}\n\n${body}`;
}

function mapRow(row: Record<string, unknown>, runTerminal: boolean): GuidanceRecord {
  const deliveredAt = (row["delivered_at"] as Date | null) ?? null;
  const undeliverableReason = (row["undeliverable_reason"] as string | null) ?? null;
  const state: GuidanceState = deliveredAt
    ? "delivered"
    : undeliverableReason
      ? "undeliverable"
      : runTerminal
        ? "superseded"
        : "queued";
  return {
    id: row["id"] as string,
    cursor: String(row["seq"]),
    at: row["at"] as Date,
    actor: row["actor"] as string,
    message: row["message"] as string,
    state,
    deliveredAt,
    undeliverableReason,
    deliveryAttempts: Number(row["delivery_attempts"] ?? 0),
  };
}
