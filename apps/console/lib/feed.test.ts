import { test } from "node:test";
import assert from "node:assert/strict";
import {
  afterStream,
  appendEvents,
  compareCursors,
  earliest,
  feedStorageKey,
  feedView,
  laterCursor,
  liveLine,
  mergeEvents,
  olderOf,
  restoreFeed,
  resumeFrom,
  retryDelayMs,
  sliceTail,
  storableFeed,
  STORED_MAX_AGE_MS,
} from "./feed.ts";
import type { RunEvent } from "./types.ts";

const ev = (kind: RunEvent["kind"], cursor: string): RunEvent => ({ kind, cursor, at: "2026-09-24T00:00:00Z" });

test("a stream cut for budget reconnects; a finished run stops", () => {
  assert.equal(afterStream({ cursor: "186", reason: "budget_exhausted", reconnect: true }), "reconnect");
  assert.equal(afterStream({ cursor: "186", reason: "run_terminal", reconnect: false }), "stop");
  assert.equal(afterStream({ cursor: "186", reason: "run_terminal" }), "stop");
});

test("an event already held is not shown twice after a reconnect", () => {
  const held = [ev("transition", "185"), ev("cost", "186")];
  const merged = appendEvents(held, [ev("cost", "186"), ev("transition", "187")]);
  assert.deepEqual(
    merged.map((e) => e.cursor),
    ["185", "186", "187"],
  );
});

test("backoff doubles and caps", () => {
  assert.equal(retryDelayMs(1), 1000);
  assert.equal(retryDelayMs(3), 4000);
  assert.equal(retryDelayMs(20), 30_000);
});

test("cursors order as numbers, however long", () => {
  assert.ok(compareCursors("9", "10") < 0);
  assert.ok(compareCursors("90071992547409930", "90071992547409929") > 0, "past 2^53 without losing precision");
  assert.equal(compareCursors("42", "42"), 0);
});

test("the tail, older pages and the stream merge into one feed, in order, each event once", () => {
  const tail = [ev("transition", "10"), ev("agent", "11"), ev("cost", "12")];
  const older = [ev("transition", "4"), ev("agent", "9"), ev("transition", "10")];
  const live = [ev("cost", "12"), ev("agent", "13")];
  assert.deepEqual(mergeEvents(older, tail, live).map((e) => e.cursor), ["4", "9", "10", "11", "12", "13"]);
  assert.deepEqual(mergeEvents(live, tail).map((e) => e.cursor), ["10", "11", "12", "13"]);
});

test("a tail cut from a whole feed is the newest page, and says whether older ones remain", () => {
  const all = ["1", "2", "3", "4", "5"].map((c) => ev("agent", c));
  const tail = sliceTail(all, undefined, 2);
  assert.deepEqual(tail.items.map((e) => e.cursor), ["4", "5"]);
  assert.equal(tail.startCursor, "4");
  assert.equal(tail.endCursor, "5");
  assert.equal(tail.hasPreviousPage, true);

  const before = sliceTail(all, "4", 5);
  assert.deepEqual(before.items.map((e) => e.cursor), ["1", "2", "3"]);
  assert.equal(before.hasPreviousPage, false);

  const empty = sliceTail([], undefined, 10);
  assert.equal(empty.endCursor, "0", "a run with no events is followed from the start");
  assert.equal(empty.startCursor, null);
});

test("of several older-page pointers, the one reaching furthest back decides", () => {
  assert.deepEqual(earliest({ cursor: "40", more: true }, null, { cursor: "12", more: false }), { cursor: "12", more: false });
  assert.equal(earliest(null, undefined), null);
  assert.deepEqual(olderOf({ startCursor: "7", hasPreviousPage: true }), { cursor: "7", more: true });
  assert.equal(olderOf({ startCursor: null, hasPreviousPage: false }), null);
  assert.equal(laterCursor("99", "100"), "100");
  assert.equal(laterCursor(null, "5"), "5");
});

const NOW = Date.parse("2026-10-16T12:00:00Z");

test("a saved feed round-trips, and anything stale, foreign or malformed is ignored rather than trusted", () => {
  const saved = storableFeed("run-1", [ev("transition", "3"), ev("agent", "4")], "4", { cursor: "3", more: true }, NOW);
  const raw = JSON.stringify(saved);
  assert.deepEqual(restoreFeed(raw, "run-1", NOW + 1000), saved);

  assert.equal(restoreFeed(raw, "run-2", NOW), null, "another run's feed");
  assert.equal(restoreFeed(raw, "run-1", NOW + STORED_MAX_AGE_MS + 1), null, "too old to resume from");
  assert.equal(restoreFeed("{not json", "run-1", NOW), null);
  assert.equal(restoreFeed(null, "run-1", NOW), null);
  assert.equal(restoreFeed(JSON.stringify({ ...saved, cursor: "yesterday" }), "run-1", NOW), null, "a cursor the API never issued");
  assert.equal(restoreFeed(JSON.stringify({ ...saved, v: 2 }), "run-1", NOW), null);

  const junk = restoreFeed(JSON.stringify({ ...saved, events: [ev("agent", "5"), null, { kind: "agent" }, ev("agent", "5")] }), "run-1", NOW);
  assert.deepEqual(junk?.events.map((e) => e.cursor), ["5"], "bad rows dropped, repeats merged");
  assert.equal(feedStorageKey("run-1"), "windkeel:feed:run-1");
});

test("saving keeps the newest events and moves the older pointer up to what it let go", () => {
  const events = ["1", "2", "3", "4", "5"].map((c) => ev("agent", c));
  const saved = storableFeed("r", events, "5", null, NOW, 3);
  assert.deepEqual(saved.events.map((e) => e.cursor), ["3", "4", "5"]);
  assert.deepEqual(saved.older, { cursor: "3", more: true }, "the dropped two are still offered as earlier activity");
  assert.deepEqual(storableFeed("r", events, "5", { cursor: "1", more: false }, NOW).older, { cursor: "1", more: false });
});

test("a reload resumes from the saved cursor, or from the page's head without one", () => {
  const saved = storableFeed("r", [ev("agent", "40")], "40", null, NOW);
  assert.equal(resumeFrom(saved, "55"), "40", "the stream brings 41–55, so nothing between is lost");
  assert.equal(resumeFrom(null, "55"), "55");
});

test("restored events, the server's tail and the stream merge without repeats", () => {
  const stored = storableFeed("r", [ev("transition", "10"), ev("agent", "11"), ev("agent", "12")], "12", { cursor: "10", more: true }, NOW);
  const tail = { items: [ev("agent", "12"), ev("cost", "13"), ev("agent", "14")], startCursor: "12", hasPreviousPage: true };
  const live = [ev("agent", "14"), ev("agent", "15")];
  const view = feedView({ stored, tail, earlier: [], earlierFrom: null, live, resumed: true });
  assert.deepEqual(view.events.map((e) => e.cursor), ["10", "11", "12", "13", "14", "15"]);
  assert.deepEqual(view.older, { cursor: "10", more: true }, "earlier activity starts before the restored events");

  const early = feedView({ stored, tail: null, earlier: [], earlierFrom: null, live: [], resumed: true });
  assert.deepEqual(early.events.map((e) => e.cursor), ["10", "11", "12"]);
});

test("restored events that would sit above a gap are dropped when no stream will fill it", () => {
  const stored = storableFeed("r", [ev("agent", "10"), ev("agent", "11")], "11", null, NOW);
  const tail = { items: [ev("agent", "200"), ev("transition", "201")], startCursor: "200", hasPreviousPage: true };
  const ended = feedView({ stored, tail, earlier: [], earlierFrom: null, live: [], resumed: false });
  assert.deepEqual(ended.events.map((e) => e.cursor), ["200", "201"]);
  assert.deepEqual(ended.older, { cursor: "200", more: true });

  const following = feedView({ stored, tail, earlier: [], earlierFrom: null, live: [ev("agent", "12")], resumed: true });
  assert.deepEqual(following.events.map((e) => e.cursor), ["10", "11", "12", "200", "201"]);

  const near = { items: [ev("agent", "11"), ev("agent", "12")], startCursor: "11", hasPreviousPage: true };
  assert.deepEqual(feedView({ stored, tail: near, earlier: [], earlierFrom: null, live: [], resumed: false }).events.map((e) => e.cursor), ["10", "11", "12"]);
});

test("a run parked on a person says it's waiting on you, not live", () => {
  assert.deepEqual(liveLine({ link: "live", stopReason: null, resuming: false, parked: true }), { text: "Waiting on you", tone: "waiting" });
  assert.equal(liveLine({ link: "live", stopReason: null, resuming: false, parked: false }).text, "Live");
  assert.equal(liveLine({ link: "reconnecting", stopReason: null, resuming: false, parked: true }).text, "Reconnecting…", "a dropped connection still says so");
  assert.equal(liveLine({ link: "ended", stopReason: null, resuming: false, parked: false }).text, "This run has ended.");
  assert.equal(liveLine({ link: "connecting", stopReason: null, resuming: true, parked: false }).text, "Resuming…");
  assert.equal(liveLine({ link: "live", stopReason: "refused: too many streams", resuming: false, parked: true }).text, "Live updates stopped: too many streams.");
});
