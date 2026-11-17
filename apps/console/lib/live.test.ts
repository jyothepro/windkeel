import { test } from "node:test";
import assert from "node:assert/strict";
import { createRefreshScheduler, DEBOUNCE_MS, fallbackDue, firstSighting, FALLBACK_REFRESH_MS, MIN_GAP_MS, RUN_GAP_MS, type Timers } from "./live.ts";

function fakeTimers(): Timers & { advance(ms: number): void } {
  let clock = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => clock,
    setTimeout(fn, ms) {
      const id = next++;
      pending.set(id, { at: clock + ms, fn });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id as number);
    },
    advance(ms) {
      const until = clock + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        clock = due[1].at;
        due[1].fn();
      }
      clock = until;
    },
  };
}

test("a burst of changes is one refresh, a moment after it starts", () => {
  const t = fakeTimers();
  const s = createRefreshScheduler({ debounceMs: 1000, minGapMs: 0 }, t);
  let refreshes = 0;
  const refresh = () => refreshes++;
  s.request(refresh);
  t.advance(400);
  s.request(refresh);
  t.advance(400);
  s.request(refresh);
  t.advance(199);
  assert.equal(refreshes, 0, "still inside the burst");
  t.advance(1);
  assert.equal(refreshes, 1, "three asks, one refresh");
  t.advance(5000);
  assert.equal(refreshes, 1);
});

test("a steady trickle of changes can't postpone the refresh forever", () => {
  const t = fakeTimers();
  const s = createRefreshScheduler({ debounceMs: 1000, minGapMs: 0 }, t);
  let refreshes = 0;
  for (let i = 0; i < 10; i++) {
    s.request(() => refreshes++);
    t.advance(300);
  }
  assert.ok(refreshes >= 2, `got ${refreshes}`);
});

test("other runs' changes refresh at most every ten seconds, however busy the organization", () => {
  const t = fakeTimers();
  const s = createRefreshScheduler({ debounceMs: DEBOUNCE_MS, minGapMs: MIN_GAP_MS }, t);
  let refreshes = 0;
  for (let i = 0; i < 120; i++) {
    s.request(() => refreshes++);
    t.advance(500);
  }
  t.advance(MIN_GAP_MS);
  assert.ok(refreshes <= 60_000 / MIN_GAP_MS + 1, `got ${refreshes}`);
  assert.ok(refreshes >= 60_000 / MIN_GAP_MS - 1, "and none is dropped for good");
});

test("the open run's own transition refreshes after the debounce and the shorter gap, even behind a list change", () => {
  const t = fakeTimers();
  const s = createRefreshScheduler({ debounceMs: DEBOUNCE_MS, minGapMs: MIN_GAP_MS }, t);
  let refreshes = 0;
  t.advance(RUN_GAP_MS);
  s.request(() => refreshes++, RUN_GAP_MS);
  t.advance(DEBOUNCE_MS);
  assert.equal(refreshes, 1, "4 s after the last refresh, a second after the transition");

  s.request(() => refreshes++);
  t.advance(100);
  s.request(() => refreshes++, RUN_GAP_MS);
  t.advance(RUN_GAP_MS - 101);
  assert.equal(refreshes, 1);
  t.advance(1);
  assert.equal(refreshes, 2, "the run's gap, not the list's");

  for (let i = 0; i < 20; i++) {
    s.request(() => refreshes++, RUN_GAP_MS);
    t.advance(200);
  }
  assert.ok(refreshes <= 2 + Math.ceil(4000 / RUN_GAP_MS), `got ${refreshes}`);
});

test("a cancelled scheduler refreshes nothing", () => {
  const t = fakeTimers();
  const s = createRefreshScheduler({ debounceMs: 100, minGapMs: 0 }, t);
  let refreshes = 0;
  s.request(() => refreshes++);
  s.cancel();
  t.advance(1000);
  assert.equal(refreshes, 0);
});

test("the fallback poll is due only after five quiet minutes", () => {
  assert.equal(fallbackDue(0, FALLBACK_REFRESH_MS - 1), false);
  assert.equal(fallbackDue(0, FALLBACK_REFRESH_MS), true);
});

test("a change answered twice — unsettled, or across a reconnect — is news once", () => {
  const seen: string[] = [];
  assert.equal(firstSighting(seen, "41"), true);
  assert.equal(firstSighting(seen, "41"), false);
  assert.equal(firstSighting(seen, "42"), true);
  for (let i = 0; i < 10; i++) firstSighting(seen, String(100 + i), 5);
  assert.equal(seen.length, 5, "bounded");
});
