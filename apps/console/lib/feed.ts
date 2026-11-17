import type { RunEvent } from "./types.ts";

export interface CursorFrame {
  cursor: string;
  reason: string;
  reconnect?: boolean;
}

export type AfterStream = "reconnect" | "stop";

export function afterStream(frame: CursorFrame): AfterStream {
  if (frame.reason === "run_terminal") return "stop";
  return frame.reconnect === false ? "stop" : "reconnect";
}

export function appendEvents(held: readonly RunEvent[], incoming: readonly RunEvent[]): RunEvent[] {
  const seen = new Set(held.map((e) => `${e.kind}:${e.cursor}`));
  const out = [...held];
  for (const e of incoming) {
    const key = `${e.kind}:${e.cursor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

export function retryDelayMs(failures: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, failures - 1));
}

export function compareCursors(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function mergeEvents(...lists: ReadonlyArray<readonly RunEvent[]>): RunEvent[] {
  const byKey = new Map<string, RunEvent>();
  for (const list of lists) for (const e of list) if (!byKey.has(`${e.kind}:${e.cursor}`)) byKey.set(`${e.kind}:${e.cursor}`, e);
  return [...byKey.values()].sort((a, b) => compareCursors(a.cursor, b.cursor));
}

export interface Older {
  cursor: string;
  more: boolean;
}

export function earliest(...pointers: ReadonlyArray<Older | null | undefined>): Older | null {
  let best: Older | null = null;
  for (const p of pointers) if (p && (!best || compareCursors(p.cursor, best.cursor) < 0)) best = p;
  return best;
}

export function olderOf(page: { startCursor: string | null; hasPreviousPage: boolean } | null | undefined): Older | null {
  return page?.startCursor ? { cursor: page.startCursor, more: page.hasPreviousPage } : null;
}

export function laterCursor(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return compareCursors(a, b) >= 0 ? a : b;
}

export function sliceTail(all: readonly RunEvent[], before: string | undefined, limit: number) {
  const eligible = before ? all.filter((e) => compareCursors(e.cursor, before) < 0) : [...all];
  const items = eligible.slice(Math.max(0, eligible.length - limit));
  return {
    items,
    startCursor: items[0]?.cursor ?? null,
    endCursor: items.at(-1)?.cursor ?? (before ? before : "0"),
    hasPreviousPage: eligible.length > items.length,
  };
}

export interface StoredFeed {
  v: 1;
  runId: string;
  cursor: string;
  events: RunEvent[];
  older: Older | null;
  savedAt: number;
}

export const STORED_MAX_EVENTS = 300;
export const STORED_MAX_AGE_MS = 30 * 60_000;

export const feedStorageKey = (runId: string) => `windkeel:feed:${runId}`;

export function restoreFeed(raw: string | null, runId: string, now: number): StoredFeed | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const s = parsed as Partial<StoredFeed> | null;
  if (!s || s.v !== 1 || s.runId !== runId || typeof s.cursor !== "string" || !/^\d+$/.test(s.cursor)) return null;
  if (typeof s.savedAt !== "number" || now - s.savedAt > STORED_MAX_AGE_MS || s.savedAt > now + 60_000) return null;
  if (!Array.isArray(s.events)) return null;
  const events = s.events.filter((e): e is RunEvent => Boolean(e) && typeof e.cursor === "string" && /^\d+$/.test(e.cursor) && typeof e.kind === "string");
  const older = s.older && typeof s.older.cursor === "string" && /^\d+$/.test(s.older.cursor) ? { cursor: s.older.cursor, more: Boolean(s.older.more) } : null;
  return { v: 1, runId, cursor: s.cursor, events: mergeEvents(events), older, savedAt: s.savedAt };
}

export function storableFeed(runId: string, events: readonly RunEvent[], cursor: string, older: Older | null, now: number, max = STORED_MAX_EVENTS): StoredFeed {
  const sorted = mergeEvents(events);
  const kept = sorted.slice(Math.max(0, sorted.length - max));
  const dropped = sorted.length > kept.length;
  return {
    v: 1,
    runId,
    cursor,
    events: kept,
    older: dropped && kept[0] ? { cursor: kept[0].cursor, more: true } : older,
    savedAt: now,
  };
}

export function resumeFrom(stored: StoredFeed | null, head: string): string {
  return stored ? stored.cursor : head;
}

export function feedView(input: {
  stored: StoredFeed | null;
  tail: { items: readonly RunEvent[]; startCursor: string | null; hasPreviousPage: boolean } | null;
  earlier: readonly RunEvent[];
  earlierFrom: Older | null;
  live: readonly RunEvent[];
  resumed: boolean;
}): { events: RunEvent[]; older: Older | null } {
  const { stored, tail, earlier, earlierFrom, live, resumed } = input;
  const keepStored =
    stored !== null &&
    (tail === null || resumed || !tail.hasPreviousPage || tail.startCursor === null || compareCursors(tail.startCursor, stored.cursor) <= 0);
  return {
    events: mergeEvents(earlier, keepStored ? stored.events : [], tail?.items ?? [], live),
    older: earliest(earlierFrom, keepStored ? stored.older : null, olderOf(tail)),
  };
}

export type FeedLink = "connecting" | "live" | "reconnecting" | "ended";
export type LiveTone = FeedLink | "stopped" | "waiting";

export function liveLine(input: { link: FeedLink; stopReason: string | null; resuming: boolean; parked: boolean }): { text: string; tone: LiveTone } {
  const { link, stopReason, resuming, parked } = input;
  if (stopReason) return { text: `Live updates stopped: ${stopReason.replace(/^refused: /, "")}.`, tone: "stopped" };
  if (link === "ended") return { text: "This run has ended.", tone: "ended" };
  if (link === "reconnecting") return { text: "Reconnecting…", tone: "reconnecting" };
  if (parked) return { text: "Waiting on you", tone: "waiting" };
  if (link === "live") return { text: "Live", tone: "live" };
  return { text: resuming ? "Resuming…" : "Connecting…", tone: "connecting" };
}
