
import type { Queryable } from "../db/transaction.js";

export interface AgentEventRowValues {
  ordinal: number;
  type: string;

  payload: string;
}

export async function insertAgentEventRows(
  db: Queryable,
  engineeringRunId: string,
  agentRunId: string,
  events: readonly AgentEventRowValues[],
): Promise<void> {
  const values: unknown[] = [];
  const rows = events.map((event, index) => {
    values.push(engineeringRunId, agentRunId, event.ordinal, event.type, event.payload);
    const base = index * 5;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb)`;
  });
  await db.query(
    `insert into agent_event (engineering_run_id, agent_run_id, ordinal, type, payload)
     values ${rows.join(", ")}
     on conflict (agent_run_id, ordinal) do nothing`,
    values,
  );
}

export async function insertBrowserUnavailableEvent(
  db: Queryable,
  engineeringRunId: string,
  agentRunId: string,
  payload: string,
): Promise<void> {
  await db.query(
    `insert into agent_event (engineering_run_id, agent_run_id, ordinal, type, payload)
     values ($1, $2, null, 'browser_unavailable', $3::jsonb)
     on conflict (agent_run_id) where type = 'browser_unavailable' do nothing`,
    [engineeringRunId, agentRunId, payload],
  );
}
