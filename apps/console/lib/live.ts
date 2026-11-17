export interface Timers {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface RefreshScheduler {
  request(refresh: () => void, gapMs?: number): void;
  lastRefreshAt(): number;
  noteRefreshed(): void;
  cancel(): void;
}

export function createRefreshScheduler({ debounceMs, minGapMs }: { debounceMs: number; minGapMs: number }, timers: Timers = realTimers): RefreshScheduler {
  let handle: unknown;
  let last = timers.now();
  let pending: (() => void) | null = null;
  let firstAsk = 0;
  let pendingGap = minGapMs;
  const fire = () => {
    handle = undefined;
    const refresh = pending;
    pending = null;
    last = timers.now();
    refresh?.();
  };
  return {
    request(refresh, gapMs = minGapMs) {
      const now = timers.now();
      if (handle === undefined) {
        firstAsk = now;
        pendingGap = gapMs;
      } else {
        timers.clearTimeout(handle);
        pendingGap = Math.min(pendingGap, gapMs);
      }
      pending = refresh;
      const due = Math.max(firstAsk + debounceMs, last + pendingGap);
      handle = timers.setTimeout(fire, Math.max(0, due - now));
    },
    lastRefreshAt: () => last,
    noteRefreshed() {
      last = timers.now();
    },
    cancel() {
      if (handle !== undefined) timers.clearTimeout(handle);
      handle = undefined;
      pending = null;
    },
  };
}

export const DEBOUNCE_MS = 1_000;
export const MIN_GAP_MS = 10_000;
export const RUN_GAP_MS = 4_000;
let shared: RefreshScheduler | null = null;
export function sharedRefreshScheduler(): RefreshScheduler {
  shared ??= createRefreshScheduler({ debounceMs: DEBOUNCE_MS, minGapMs: MIN_GAP_MS });
  return shared;
}

export const FALLBACK_REFRESH_MS = 5 * 60_000;

export function fallbackDue(lastRefreshAt: number, now: number, everyMs = FALLBACK_REFRESH_MS): boolean {
  return now - lastRefreshAt >= everyMs;
}

export function firstSighting(seen: string[], changeId: string, max = 500): boolean {
  if (seen.includes(changeId)) return false;
  seen.push(changeId);
  if (seen.length > max) seen.splice(0, seen.length - max);
  return true;
}
