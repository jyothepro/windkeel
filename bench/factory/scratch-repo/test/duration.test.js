import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration, parseDuration } from "../src/duration.js";

test("formats seconds and minutes", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(5), "5s");
  assert.equal(formatDuration(60), "1m 0s");
  assert.equal(formatDuration(65), "1m 5s");
  assert.equal(formatDuration(3599), "59m 59s");
});

test("refuses what is not a duration", () => {
  assert.throws(() => formatDuration(-1), RangeError);
  assert.throws(() => formatDuration(1.5), RangeError);
  assert.throws(() => parseDuration("soon"), SyntaxError);
});

test("parseDuration reads back everything formatDuration writes", () => {
  for (let seconds = 0; seconds <= 100_000; seconds += 37) {
    assert.equal(parseDuration(formatDuration(seconds)), seconds, `round trip of ${seconds}`);
  }
});
