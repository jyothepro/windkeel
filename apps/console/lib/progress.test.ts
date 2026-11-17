import { test } from "node:test";
import assert from "node:assert/strict";
import { progressOf, spanText } from "./progress.ts";
import type { RunEvent } from "./types.ts";

const t0 = Date.UTC(2026, 9, 17, 12, 0, 0);
const transition = (minute: number, from: RunEvent["from"], to: RunEvent["to"]): RunEvent => ({
  kind: "transition",
  cursor: String(100 + minute),
  at: new Date(t0 + minute * 60_000).toISOString(),
  from,
  to,
  reason: null,
});

test("stops sit on the track by time, and a finished run's track ends at its last transition", () => {
  const { stops, spanMs } = progressOf(
    [transition(0, "CREATED", "PROVISIONING"), { kind: "cost", cursor: "101", at: new Date(t0).toISOString() }, transition(2, "PROVISIONING", "IMPLEMENTING"), transition(10, "IMPLEMENTING", "FAILED")],
    t0 + 60 * 60_000,
  );
  assert.equal(spanMs, 10 * 60_000);
  assert.deepEqual(
    stops.map((s) => s.offset),
    [0, 0.2, 1],
  );
  assert.deepEqual(
    stops.map((s) => s.spentMs),
    [2 * 60_000, 8 * 60_000, null],
  );
  assert.ok(stops.every((s) => !s.current), "nothing is current on a finished run");
});

test("a live run's track runs to now, and its current state's time keeps growing", () => {
  const { stops } = progressOf([transition(0, "CREATED", "PROVISIONING"), transition(5, "PROVISIONING", "IMPLEMENTING")], t0 + 20 * 60_000);
  assert.equal(stops[1]!.current, true);
  assert.equal(stops[1]!.offset, 0.25);
  assert.equal(stops[1]!.spentMs, 15 * 60_000);
});

test("no transitions is an empty track; transitions at one instant are spread evenly", () => {
  assert.deepEqual(progressOf([], t0).stops, []);
  const { stops } = progressOf([transition(0, "CREATED", "CLASSIFYING"), transition(0, "CLASSIFYING", "CANCELLED")], t0);
  assert.deepEqual(
    stops.map((s) => s.offset),
    [0, 1],
  );
});

test("durations read at a person's precision", () => {
  assert.equal(spanText(40_000), "40s");
  assert.equal(spanText(3 * 60_000), "3m");
  assert.equal(spanText(65 * 60_000), "1h 5m");
  assert.equal(spanText(51 * 3600_000), "2d 3h");
});
