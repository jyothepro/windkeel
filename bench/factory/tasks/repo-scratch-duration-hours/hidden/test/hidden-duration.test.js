import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration, parseDuration } from "../src/duration.js";

test("an hour or more shows hours, minutes and seconds", () => {
  assert.equal(formatDuration(3600), "1h 0m 0s");
  assert.equal(formatDuration(3661), "1h 1m 1s");
  assert.equal(formatDuration(7322), "2h 2m 2s");
  assert.equal(formatDuration(86399), "23h 59m 59s");
  assert.equal(formatDuration(360000), "100h 0m 0s");
});

test("under an hour is unchanged", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(59), "59s");
  assert.equal(formatDuration(60), "1m 0s");
  assert.equal(formatDuration(3599), "59m 59s");
});

test("parseDuration reads hours, and still reads what it read before", () => {
  assert.equal(parseDuration("1h 0m 0s"), 3600);
  assert.equal(parseDuration("2h 2m 2s"), 7322);
  assert.equal(parseDuration("1m 5s"), 65);
  assert.equal(parseDuration("5s"), 5);
  for (let seconds = 0; seconds <= 400_000; seconds += 113) {
    assert.equal(parseDuration(formatDuration(seconds)), seconds, `round trip of ${seconds}`);
  }
});
