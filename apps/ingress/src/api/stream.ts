import type { Pool } from "pg";
import { FEED_START, listRunEvents } from "@windkeel/factory/runs";
import { TERMINAL_STATES } from "@windkeel/factory/runs";
import { getEngineeringRun } from "@windkeel/factory/repositories";
import { listRunChanges, runChangesHead } from "@windkeel/factory/runs";
import { changeFrame, cursorFrame, eventFrame, keepAlive, resyncFrame, type CloseReason } from "./sse.js";

export interface StreamSink {
  write(chunk: string): void;
  writable(): boolean;
}

export interface StreamOptions {
  budgetMs: number;
  pollMs: number;
  keepAliveMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_STREAM_OPTIONS: Omit<StreamOptions, "budgetMs"> = {
  pollMs: 1_000,
  keepAliveMs: 15_000,
};

export interface StreamOutcome {
  reason: CloseReason;
  cursor: string;
  eventsSent: number;
}

export async function streamRunEvents(
  pool: Pool,
  engineeringRunId: string,
  sink: StreamSink,
  after: string,
  options: StreamOptions,
): Promise<StreamOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + options.budgetMs;

  let cursor = after === "" ? FEED_START : after;
  let eventsSent = 0;
  let lastWrite = now();

  for (;;) {
    if (!sink.writable()) return { reason: "client_gone", cursor, eventsSent };

    let drained = false;
    while (!drained) {
      const page = await listRunEvents(pool, engineeringRunId, cursor);
      for (const event of page.items) {
        sink.write(eventFrame(event));
        eventsSent += 1;
      }
      if (page.items.length > 0) {
        cursor = page.endCursor;
        lastWrite = now();
      }
      drained = !page.hasNextPage;
      if (!sink.writable()) return { reason: "client_gone", cursor, eventsSent };
    }

    const run = await getEngineeringRun(pool, engineeringRunId);
    if (run && TERMINAL_STATES.has(run.status)) {
      return close(sink, "run_terminal", cursor, eventsSent);
    }

    if (now() >= deadline) return close(sink, "budget_exhausted", cursor, eventsSent);

    if (now() - lastWrite >= options.keepAliveMs) {
      sink.write(keepAlive());
      lastWrite = now();
    }

    await sleep(Math.max(0, Math.min(options.pollMs, deadline - now())));
  }
}

export const DEFAULT_CHANGE_STREAM_OPTIONS: Omit<StreamOptions, "budgetMs"> = {
  pollMs: 2_000,
  keepAliveMs: 15_000,
};

export async function streamRunChanges(
  pool: Pool,
  organizationId: string,
  sink: StreamSink,
  after: string | undefined,
  options: StreamOptions,
): Promise<StreamOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + options.budgetMs;

  let cursor = after === undefined || after === "" ? await runChangesHead(pool) : after;
  let quiet = after === undefined || after === "";
  const sent = new Set<string>();
  let eventsSent = 0;
  let lastWrite = now();

  for (;;) {
    if (!sink.writable()) return { reason: "client_gone", cursor, eventsSent };

    const page = await listRunChanges(pool, organizationId, cursor);
    if (page.hasNextPage && page.endCursor !== cursor && !quiet) {
      cursor = await runChangesHead(pool);
      sent.clear();
      quiet = true;
      sink.write(resyncFrame(cursor));
      eventsSent += 1;
      lastWrite = now();
      continue;
    }
    for (const change of page.items) {
      if (sent.has(change.changeId)) continue;
      sent.add(change.changeId);
      if (quiet) continue;
      sink.write(changeFrame(change, page.endCursor));
      eventsSent += 1;
      lastWrite = now();
    }
    quiet = false;
    cursor = page.endCursor;
    for (const id of sent) if (BigInt(id) <= BigInt(cursor)) sent.delete(id);

    if (!sink.writable()) return { reason: "client_gone", cursor, eventsSent };
    if (now() >= deadline) return close(sink, "budget_exhausted", cursor, eventsSent);

    if (now() - lastWrite >= options.keepAliveMs) {
      sink.write(keepAlive());
      lastWrite = now();
    }
    await sleep(Math.max(0, Math.min(options.pollMs, deadline - now())));
  }
}

function close(sink: StreamSink, reason: CloseReason, cursor: string, eventsSent: number): StreamOutcome {
  if (sink.writable()) sink.write(cursorFrame(cursor, reason));
  return { reason, cursor, eventsSent };
}
