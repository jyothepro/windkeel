import type { Pool } from "pg";
import type { WorkerEvent } from "../worker/adapter.js";
import { withTransaction } from "./db/transaction.js";
import { lockEngineeringRunRow } from "./stores/run-store.js";
import { insertAgentEventRows, insertBrowserUnavailableEvent } from "./stores/agent-event-store.js";

export const AGENT_EVENT_TEXT_LIMIT = 4000;

const TRUNCATED = "\n… (truncated)";

function cap(text: string): string {
  return text.length <= AGENT_EVENT_TEXT_LIMIT
    ? text
    : text.slice(0, AGENT_EVENT_TEXT_LIMIT - TRUNCATED.length) + TRUNCATED;
}

function agentEventPayload(event: WorkerEvent): Record<string, unknown> {
  const { type: _type, ...rest } = event;
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    payload[key] = typeof value === "string" ? cap(value) : value;
  }
  return payload;
}

export async function recordAgentEvents(
  pool: Pool,
  engineeringRunId: string,
  agentRunId: string,
  firstOrdinal: number,
  events: readonly WorkerEvent[],
): Promise<void> {
  if (events.length === 0) return;
  await withTransaction(pool, async (client) => {
    await lockEngineeringRunRow(client, engineeringRunId);
    await insertAgentEventRows(
      client,
      engineeringRunId,
      agentRunId,
      events.map((event, index) => ({
        ordinal: firstOrdinal + index,
        type: event.type,
        payload: JSON.stringify(agentEventPayload(event)),
      })),
    );
  });
}

export async function recordBrowserUnavailable(
  pool: Pool,
  engineeringRunId: string,
  agentRunId: string,
  reason: string,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await lockEngineeringRunRow(client, engineeringRunId);
    await insertBrowserUnavailableEvent(client, engineeringRunId, agentRunId, JSON.stringify({ reason: capAgentText(reason) }));
  });
}

export function capAgentText(text: string, limit: number = AGENT_EVENT_TEXT_LIMIT): string {
  const clean = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  return clean.length <= limit ? clean : clean.slice(0, Math.max(0, limit - TRUNCATED.length)) + TRUNCATED;
}

export function eventsCounted(eventCounts: Record<string, number>): number {
  return Object.values(eventCounts).reduce((sum, n) => sum + n, 0);
}
