/**
 * `src/schedules/cron.ts` (M8-4, #296): parsing, next-fire arithmetic, the day-of-month /
 * day-of-week rule, and the two DST transitions in two zones. Pure; no database.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CronError,
  latestFireTimeAtOrBefore,
  localDate,
  nextFireTime,
  nextFireTimes,
  parseCron,
  validateSchedule,
} from "../dist/schedules/cron.js";

const iso = (dates) => dates.map((d) => d.toISOString());
const next = (cron, after, tz = "UTC", n = 3) => iso(nextFireTimes(cron, new Date(after), tz, n));

test("fields parse: lists, ranges, steps, names, and 7 as Sunday", () => {
  const e = parseCron("0,30 9-17/4 */10 jan,jun-aug mon-fri");
  assert.deepEqual([...e.minutes], [0, 30]);
  assert.deepEqual([...e.hours], [9, 13, 17]);
  assert.deepEqual([...e.daysOfMonth], [1, 11, 21, 31]);
  assert.deepEqual([...e.months], [1, 6, 7, 8]);
  assert.deepEqual([...e.daysOfWeek], [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseCron("0 0 * * 7").daysOfWeek], [0]);
  assert.deepEqual([...parseCron("5/20 * * * *").minutes], [5, 25, 45]);
});

test("macros expand to their five-field meaning", () => {
  assert.deepEqual(next("@hourly", "2026-09-25T10:15:00Z", "UTC", 2), ["2026-09-25T11:00:00.000Z", "2026-09-25T12:00:00.000Z"]);
  assert.deepEqual(next("@daily", "2026-09-25T10:15:00Z", "UTC", 1), ["2026-09-26T00:00:00.000Z"]);
  // 2026-09-25 is a Friday; @weekly is Sunday midnight.
  assert.deepEqual(next("@weekly", "2026-09-25T10:15:00Z", "UTC", 2), ["2026-09-27T00:00:00.000Z", "2026-10-04T00:00:00.000Z"]);
  assert.deepEqual(next("@monthly", "2026-09-25T10:15:00Z", "UTC", 1), ["2026-10-01T00:00:00.000Z"]);
  assert.deepEqual(next("@yearly", "2026-09-25T10:15:00Z", "UTC", 1), ["2027-01-01T00:00:00.000Z"]);
});

test("next fire is strictly after the given instant", () => {
  assert.deepEqual(next("0 9 * * *", "2026-09-25T09:00:00Z", "UTC", 1), ["2026-09-26T09:00:00.000Z"]);
  assert.deepEqual(next("0 9 * * *", "2026-09-25T08:59:59Z", "UTC", 1), ["2026-09-25T09:00:00.000Z"]);
});

test("month ends: the 31st skips short months, and Feb 29 waits for a leap year", () => {
  assert.deepEqual(next("0 0 31 * *", "2026-01-31T12:00:00Z", "UTC", 3), [
    "2026-03-31T00:00:00.000Z",
    "2026-05-31T00:00:00.000Z",
    "2026-07-31T00:00:00.000Z",
  ]);
  assert.deepEqual(next("0 0 29 2 *", "2026-01-01T00:00:00Z", "UTC", 2), [
    "2028-02-29T00:00:00.000Z",
    "2032-02-29T00:00:00.000Z",
  ]);
  assert.deepEqual(next("59 23 * * *", "2026-12-31T23:59:00Z", "UTC", 1), ["2027-01-01T23:59:00.000Z"]);
});

test("day-of-month and day-of-week: either when both are restricted, both when one is *", () => {
  // The 1st of the month OR any Monday. 2026-09-28 is a Monday; 2026-10-01 a Thursday.
  assert.deepEqual(next("0 9 1 * mon", "2026-09-25T12:00:00Z", "UTC", 3), [
    "2026-09-28T09:00:00.000Z",
    "2026-10-01T09:00:00.000Z",
    "2026-10-05T09:00:00.000Z",
  ]);
  // A `*`-leading day-of-month makes it AND: only Mondays that are also odd days.
  assert.deepEqual(next("0 9 */2 * mon", "2026-09-25T12:00:00Z", "UTC", 2), [
    "2026-10-05T09:00:00.000Z",
    "2026-10-19T09:00:00.000Z",
  ]);
  // Only day-of-week restricted: every Monday.
  assert.deepEqual(next("0 9 * * 1", "2026-09-25T12:00:00Z", "UTC", 2), [
    "2026-09-28T09:00:00.000Z",
    "2026-10-05T09:00:00.000Z",
  ]);
});

test("evaluated in the schedule's zone, not UTC", () => {
  // 09:00 in New York in September is 13:00Z (EDT, UTC-4).
  assert.deepEqual(next("0 9 * * *", "2026-09-25T12:00:00Z", "America/New_York", 1), ["2026-09-25T13:00:00.000Z"]);
  assert.equal(localDate(new Date("2026-09-26T02:00:00Z"), "America/New_York"), "2026-09-25");
});

test("America/New_York spring forward: a skipped wall time fires once, an hour on", () => {
  // 2026-03-08 02:00 EST → 03:00 EDT. 02:30 does not exist that day.
  assert.deepEqual(next("30 2 * * *", "2026-03-07T12:00:00Z", "America/New_York", 3), [
    "2026-03-08T07:30:00.000Z", // the gap: 02:30 EST ≡ 03:30 EDT
    "2026-03-09T06:30:00.000Z", // 02:30 EDT
    "2026-03-10T06:30:00.000Z",
  ]);
  // A time either side of the gap is unaffected.
  assert.deepEqual(next("0 9 * * *", "2026-03-07T12:00:00Z", "America/New_York", 2), [
    "2026-03-07T14:00:00.000Z",
    "2026-03-08T13:00:00.000Z",
  ]);
});

test("America/New_York fall back: a fixed-hour job fires once; a wildcard-hour job keeps its cadence", () => {
  // 2026-11-01 02:00 EDT → 01:00 EST. 01:30 happens twice.
  assert.deepEqual(next("30 1 * * *", "2026-10-31T12:00:00Z", "America/New_York", 3), [
    "2026-11-01T05:30:00.000Z", // first 01:30 (EDT) only
    "2026-11-02T06:30:00.000Z",
    "2026-11-03T06:30:00.000Z",
  ]);
  assert.deepEqual(next("*/30 * * * *", "2026-11-01T04:10:00Z", "America/New_York", 6), [
    "2026-11-01T04:30:00.000Z",
    "2026-11-01T05:00:00.000Z",
    "2026-11-01T05:30:00.000Z",
    "2026-11-01T06:00:00.000Z", // 01:00 EST, the second pass
    "2026-11-01T06:30:00.000Z",
    "2026-11-01T07:00:00.000Z",
  ]);
  // Starting inside the repeated hour still finds the earliest later instant.
  assert.deepEqual(next("*/10 * * * *", "2026-11-01T05:15:00Z", "America/New_York", 2), [
    "2026-11-01T05:20:00.000Z",
    "2026-11-01T05:30:00.000Z",
  ]);
});

test("Europe/London spring forward and fall back", () => {
  // 2026-03-29 01:00 GMT → 02:00 BST: 01:30 does not exist.
  assert.deepEqual(next("30 1 * * *", "2026-03-28T12:00:00Z", "Europe/London", 3), [
    "2026-03-29T01:30:00.000Z", // 01:30 GMT ≡ 02:30 BST
    "2026-03-30T00:30:00.000Z",
    "2026-03-31T00:30:00.000Z",
  ]);
  // 2026-10-25 02:00 BST → 01:00 GMT: 01:30 happens twice; a daily job runs once.
  assert.deepEqual(next("30 1 * * *", "2026-10-24T12:00:00Z", "Europe/London", 3), [
    "2026-10-25T00:30:00.000Z",
    "2026-10-26T01:30:00.000Z",
    "2026-10-27T01:30:00.000Z",
  ]);
  // Hourly through the fall back: 25 slots in that day, none twice.
  const day = nextFireTimes("0 * * * *", new Date("2026-10-24T22:59:00Z"), "Europe/London", 26);
  assert.equal(new Set(iso(day)).size, 26);
  for (let i = 1; i < day.length; i++) assert.equal(day[i] - day[i - 1], 3_600_000);
});

test("invalid expressions are CronErrors with a reason", () => {
  for (const [bad, pattern] of [
    ["", /empty/],
    ["* * * *", /5 fields/],
    ["* * * * * *", /5 fields/],
    ["60 * * * *", /out of range/],
    ["* 24 * * *", /out of range/],
    ["* * 0 * *", /out of range/],
    ["* * * 13 *", /out of range/],
    ["* * * * 8", /out of range/],
    ["*/0 * * * *", /step/],
    ["5-1 * * * *", /backwards/],
    ["a * * * *", /not a valid minute/],
    ["1,,2 * * * *", /empty list item/],
    ["@fortnightly", /unknown macro/],
  ]) {
    assert.throws(() => parseCron(bad), (e) => e instanceof CronError && pattern.test(e.message), bad);
  }
  assert.throws(() => validateSchedule("0 0 31 4 *", "UTC"), { code: "invalid_cron", message: /never fires/ });
  assert.throws(() => validateSchedule("@daily", "Mars/Olympus"), { code: "invalid_timezone", message: /unknown time zone/ });
  assert.throws(() => validateSchedule("@daily", " "), { code: "invalid_timezone" });
  assert.throws(() => validateSchedule("61 * * * *", "UTC"), { code: "invalid_cron" });
  // The first slot comes back with the expression, computed once.
  const { next } = validateSchedule("0 9 * * *", "UTC", new Date("2026-09-25T10:00:00Z"));
  assert.equal(next.toISOString(), "2026-09-26T09:00:00.000Z");
  assert.throws(() => nextFireTime("@daily", new Date(), "Not/AZone"), CronError);
});

test("the latest missed slot is found without walking every slot", () => {
  const latest = latestFireTimeAtOrBefore(
    "*/5 * * * *",
    new Date("2026-01-01T00:00:00Z"),
    new Date("2026-03-01T05:32:10Z"),
    "UTC",
  );
  assert.equal(latest.toISOString(), "2026-03-01T05:30:00.000Z");
  // At exactly a slot, that slot.
  assert.equal(
    latestFireTimeAtOrBefore("@hourly", new Date("2026-03-01T03:00:00Z"), new Date("2026-03-01T05:00:00Z"), "UTC").toISOString(),
    "2026-03-01T05:00:00.000Z",
  );
  // Never earlier than the stored slot.
  assert.equal(
    latestFireTimeAtOrBefore("@weekly", new Date("2026-09-27T00:00:00Z"), new Date("2026-09-28T00:00:00Z"), "UTC").toISOString(),
    "2026-09-27T00:00:00.000Z",
  );
});
