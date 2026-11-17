

import type { Pool, PoolClient } from "pg";
import { FEED_START, InvalidCursorError } from "./run-events.js";
import type { RunState } from "./run-state-machine.js";
import { selectRunChangeRows, selectSettledTransitionHead } from "./stores/run-feed-store.js";

export const SETTLE_SECONDS = 30;

const CHANGE_WINDOW = 500;

export interface RunChange {
  kind: "run.changed";

  changeId: string;
  runId: string;
  taskId: string;
  from: RunState | null;
  state: RunState;
  at: Date;
}

export interface RunChangePage {

  items: RunChange[];

  endCursor: string;

  hasNextPage: boolean;
}

export async function runChangesHead(db: Pool | PoolClient): Promise<string> {

  const seq = await selectSettledTransitionHead(db, SETTLE_SECONDS);
  return seq !== undefined ? String(seq) : FEED_START;
}

export async function listRunChanges(
  db: Pool | PoolClient,
  organizationId: string,
  cursor: string,
  window: number = CHANGE_WINDOW,
): Promise<RunChangePage> {
  if (!/^\d+$/.test(cursor)) throw new InvalidCursorError(cursor);
  if (window < 1) throw new RangeError(`window must be at least 1, got ${window}`);

  const rows = await selectRunChangeRows(db, organizationId, cursor, window, SETTLE_SECONDS);

  let endCursor = cursor;
  const items: RunChange[] = [];
  for (const row of rows) {
    if (row["settled"]) endCursor = String(row["seq"]);
    if (!row["mine"]) continue;
    items.push({
      kind: "run.changed",
      changeId: String(row["seq"]),
      runId: row["engineering_run_id"] as string,
      taskId: row["task_id"] as string,
      from: (row["from_state"] as RunState | null) ?? null,
      state: row["to_state"] as RunState,
      at: row["at"] as Date,
    });
  }
  return { items, endCursor, hasNextPage: rows.length >= window };
}
