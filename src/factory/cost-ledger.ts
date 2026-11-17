import type { Pool } from "pg";
import type { KeySource } from "./model-policy.js";
import { withTransaction } from "./db/transaction.js";
import { lockEngineeringRunRow } from "./stores/run-store.js";
import { incrementEngineeringRunCost, insertCostEventRow, selectCostEventTotal } from "./stores/cost-store.js";

export type CostStageType = "agent_run" | "verification_run" | "workspace" | "criteria";
export type CostKind = "model" | "sandbox";

export interface CostEventInput {
  engineeringRunId: string;
  stageType: CostStageType;
  stageId: string;
  kind: CostKind;
  tokensIn?: number | null;
  tokensOut?: number | null;

  usd: number | null;

  keySource?: KeySource | undefined;

  credentialId?: string | null | undefined;

  model?: string | null | undefined;

  sandboxMs?: number | null | undefined;
}

export interface CostEvent {
  id: string;

  seq: string;
  engineeringRunId: string;
  stageType: CostStageType;
  stageId: string;
  kind: CostKind;
  tokensIn: number | null;
  tokensOut: number | null;
  usd: number | null;

  keySource: KeySource | null;
  credentialId: string | null;
  model: string | null;
  recordedAt: Date;
}

function rowToCostEvent(row: Record<string, unknown>): CostEvent {
  return {
    id: row.id as string,
    seq: String(row.seq),
    engineeringRunId: row.engineering_run_id as string,
    stageType: row.stage_type as CostStageType,
    stageId: row.stage_id as string,
    kind: row.kind as CostKind,
    tokensIn: row.tokens_in as number | null,
    tokensOut: row.tokens_out as number | null,
    usd: row.usd === null ? null : Number(row.usd),
    keySource: (row.key_source as KeySource | null) ?? null,
    credentialId: (row.credential_id as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    recordedAt: row.recorded_at as Date,
  };
}

function assertChargeable(event: CostEventInput): void {
  const bad = (value: number | null | undefined) =>
    value !== null && value !== undefined && !(Number.isFinite(value) && value >= 0);
  if (bad(event.usd) || bad(event.tokensIn) || bad(event.tokensOut) || bad(event.sandboxMs)) {
    throw new Error(
      `recordCost: refusing a ${event.kind} cost for run ${event.engineeringRunId} with a negative ` +
        `or non-finite amount (usd=${event.usd}, tokensIn=${event.tokensIn}, tokensOut=${event.tokensOut})`,
    );
  }
}

export async function recordCost(pool: Pool, event: CostEventInput): Promise<CostEvent> {
  assertChargeable(event);
  return withTransaction(pool, async (client) => {

    await lockEngineeringRunRow(client, event.engineeringRunId);
    const row = await insertCostEventRow(client, {
      engineeringRunId: event.engineeringRunId,
      stageType: event.stageType,
      stageId: event.stageId,
      kind: event.kind,
      tokensIn: event.tokensIn ?? null,
      tokensOut: event.tokensOut ?? null,
      usd: event.usd,
      keySource: event.keySource ?? null,
      credentialId: event.keySource === "customer" ? (event.credentialId ?? null) : null,
      model: event.model ?? null,
      sandboxMs:
        event.kind === "sandbox" && event.sandboxMs !== undefined && event.sandboxMs !== null ? Math.round(event.sandboxMs) : null,
    });

    await incrementEngineeringRunCost(client, event.engineeringRunId, event.usd ?? 0);
    return rowToCostEvent(row);
  });
}

export async function sumCostEvents(pool: Pool, engineeringRunId: string): Promise<number> {
  return Number(await selectCostEventTotal(pool, engineeringRunId));
}
