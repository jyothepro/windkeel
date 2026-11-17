

import type { Pool, PoolClient } from "pg";
import type { RunState } from "./run-state-machine.js";
import { selectFeedRowsAfter, selectFeedRowsBefore } from "./stores/run-feed-store.js";

export interface TransitionEvent {
  kind: "transition";
  cursor: string;
  at: Date;
  from: RunState | null;
  to: RunState;
  reason: string | null;
}

export interface CostEventRecord {
  kind: "cost";
  cursor: string;
  at: Date;
  stageType: "agent_run" | "verification_run" | "workspace" | "criteria";
  stageId: string;
  costKind: "model" | "sandbox";

  usd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
}

export interface AgentEventRecord {
  kind: "agent";
  cursor: string;
  at: Date;
  agentRunId: string;

  role: string;
  event: { type: string } & Record<string, unknown>;
}

export type RunEvent = TransitionEvent | CostEventRecord | AgentEventRecord;

export interface RunEventPage {
  items: RunEvent[];
  endCursor: string;
  hasNextPage: boolean;
}

export const FEED_START = "0";

const DEFAULT_FEED_LIMIT = 200;

export type RunEventKind = RunEvent["kind"];
const RUN_EVENT_KINDS: readonly RunEventKind[] = ["transition", "cost", "agent"];
const ALL_KINDS: ReadonlySet<RunEventKind> = new Set(RUN_EVENT_KINDS);

function feedSql(kinds: ReadonlySet<RunEventKind>, seqFilter: (column: string) => string): string {
  const parts: string[] = [];
  if (kinds.has("transition")) {
    parts.push(`select seq, at as at, 'transition' as kind,
              from_state::text as from_state, to_state::text as to_state, reason::text as reason,
              null::text as stage_type, null::uuid as stage_id, null::text as cost_kind,
              null::numeric as usd, null::integer as tokens_in, null::integer as tokens_out,
              null::uuid as agent_run_id, null::text as agent_role, null::text as event_type, null::jsonb as payload
         from run_state_transition
        where engineering_run_id = $1 and ${seqFilter("seq")}`);
  }
  if (kinds.has("cost")) {
    parts.push(`select seq, recorded_at as at, 'cost' as kind,
              null::text as from_state, null::text as to_state, null::text as reason,
              stage_type::text as stage_type, stage_id, kind::text as cost_kind,
              usd, tokens_in, tokens_out,
              null::uuid as agent_run_id, null::text as agent_role, null::text as event_type, null::jsonb as payload
         from cost_event
        where engineering_run_id = $1 and ${seqFilter("seq")}`);
  }
  if (kinds.has("agent")) {
    parts.push(`select e.seq, e.at, 'agent' as kind,
              null::text as from_state, null::text as to_state, null::text as reason,
              null::text as stage_type, null::uuid as stage_id, null::text as cost_kind,
              null::numeric as usd, null::integer as tokens_in, null::integer as tokens_out,
              e.agent_run_id, a.role::text as agent_role, e.type::text as event_type, e.payload
         from agent_event e
         join agent_run a on a.id = e.agent_run_id
        where e.engineering_run_id = $1 and ${seqFilter("e.seq")}`);
  }
  return parts.join("\n       union all\n       ");
}

export async function listRunEvents(
  db: Pool | PoolClient,
  engineeringRunId: string,
  cursor: string = FEED_START,
  limit: number = DEFAULT_FEED_LIMIT,
  kinds: ReadonlySet<RunEventKind> = ALL_KINDS,
): Promise<RunEventPage> {
  if (!/^\d+$/.test(cursor)) throw new InvalidCursorError(cursor);
  if (limit < 1) throw new RangeError(`limit must be at least 1, got ${limit}`);
  if (kinds.size === 0) return { items: [], endCursor: cursor, hasNextPage: false };

  const rows = await selectFeedRowsAfter(db, feedSql(kinds, (seq) => `${seq} > $2`), engineeringRunId, cursor, limit + 1);

  const hasNextPage = rows.length > limit;
  const page = hasNextPage ? rows.slice(0, limit) : rows;
  const items = page.map(rowToEvent);

  return {
    items,
    endCursor: items.length > 0 ? String(page[page.length - 1]!["seq"]) : cursor,
    hasNextPage,
  };
}

export interface RunEventTailPage {
  items: RunEvent[];

  startCursor: string | null;

  endCursor: string;
  hasPreviousPage: boolean;
}

export async function listRunEventsBefore(
  db: Pool | PoolClient,
  engineeringRunId: string,
  before: string | null,
  limit: number = DEFAULT_FEED_LIMIT,
  kinds: ReadonlySet<RunEventKind> = ALL_KINDS,
): Promise<RunEventTailPage> {
  if (before !== null && !/^\d+$/.test(before)) throw new InvalidCursorError(before);
  if (limit < 1) throw new RangeError(`limit must be at least 1, got ${limit}`);
  const emptyEnd = before === null ? FEED_START : String(BigInt(before) > 0n ? BigInt(before) - 1n : 0n);
  if (kinds.size === 0) return { items: [], startCursor: null, endCursor: emptyEnd, hasPreviousPage: false };

  const rows = await selectFeedRowsBefore(
    db,
    feedSql(kinds, (seq) => `($2::bigint is null or ${seq} < $2::bigint)`),
    engineeringRunId,
    before,
    limit + 1,
  );

  const hasPreviousPage = rows.length > limit;
  const page = (hasPreviousPage ? rows.slice(0, limit) : rows).reverse();
  const items = page.map(rowToEvent);
  return {
    items,
    startCursor: items[0]?.cursor ?? null,
    endCursor: items.at(-1)?.cursor ?? emptyEnd,
    hasPreviousPage,
  };
}

export function parseEventKinds(raw: string | undefined): ReadonlySet<RunEventKind> {
  if (raw === undefined || raw.trim() === "") return ALL_KINDS;
  const kinds = new Set<RunEventKind>();
  for (const part of raw.split(",")) {
    const kind = part.trim();
    if (!(RUN_EVENT_KINDS as readonly string[]).includes(kind)) throw new InvalidEventKindError(kind);
    kinds.add(kind as RunEventKind);
  }
  return kinds;
}

export class InvalidEventKindError extends Error {
  constructor(readonly kind: string) {
    super(`kind must be one of ${RUN_EVENT_KINDS.join(", ")}, got ${JSON.stringify(kind)}`);
    this.name = "InvalidEventKindError";
  }
}

function rowToEvent(row: Record<string, unknown>): RunEvent {
  const cursor = String(row["seq"]);
  const at = row["at"] as Date;
  if (row["kind"] === "agent") {
    return {
      kind: "agent",
      cursor,
      at,
      agentRunId: row["agent_run_id"] as string,
      role: row["agent_role"] as string,
      event: { ...((row["payload"] as Record<string, unknown> | null) ?? {}), type: row["event_type"] as string },
    };
  }
  if (row["kind"] === "transition") {
    return {
      kind: "transition",
      cursor,
      at,
      from: row["from_state"] as RunState | null,
      to: row["to_state"] as RunState,
      reason: row["reason"] as string | null,
    };
  }
  return {
    kind: "cost",
    cursor,
    at,
    stageType: row["stage_type"] as CostEventRecord["stageType"],
    stageId: row["stage_id"] as string,
    costKind: row["cost_kind"] as CostEventRecord["costKind"],
    usd: row["usd"] === null ? null : Number(row["usd"]),
    tokensIn: row["tokens_in"] === null ? null : Number(row["tokens_in"]),
    tokensOut: row["tokens_out"] === null ? null : Number(row["tokens_out"]),
  };
}

export class InvalidCursorError extends Error {
  constructor(readonly cursor: string) {
    super(`cursor must be a sequence value, got ${JSON.stringify(cursor)}`);
    this.name = "InvalidCursorError";
  }
}
