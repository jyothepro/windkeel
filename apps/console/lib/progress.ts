import { TERMINAL_STATES, type RunState } from "./run-states.ts";
import type { RunEvent } from "./types.ts";

export interface ProgressStop {
  key: string;
  state: RunState;
  from: RunState | null;
  at: string;
  reason: string | null;
  offset: number;
  spentMs: number | null;
  current: boolean;
}

export function progressOf(events: readonly RunEvent[], now: number): { stops: ProgressStop[]; spanMs: number } {
  const transitions = events.filter((e): e is RunEvent & { to: RunState } => e.kind === "transition" && Boolean(e.to));
  if (transitions.length === 0) return { stops: [], spanMs: 0 };
  const times = transitions.map((t) => Date.parse(t.at));
  const start = times[0]!;
  const last = transitions.at(-1)!;
  const ended = TERMINAL_STATES.has(last.to);
  const end = ended ? times.at(-1)! : Math.max(now, times.at(-1)!);
  const span = Math.max(0, end - start);
  const stops = transitions.map((t, i): ProgressStop => {
    const next = times[i + 1];
    const isLast = i === transitions.length - 1;
    return {
      key: `transition:${t.cursor}`,
      state: t.to,
      from: t.from ?? null,
      at: t.at,
      reason: t.reason ?? null,
      offset: span === 0 ? (transitions.length === 1 ? 0 : i / (transitions.length - 1)) : (times[i]! - start) / span,
      spentMs: next !== undefined ? next - times[i]! : ended ? null : Math.max(0, now - times[i]!),
      current: isLast && !ended,
    };
  });
  return { stops, spanMs: span };
}

export function spanText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}
