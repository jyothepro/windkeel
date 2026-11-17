import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WatermarkedLineReader,
  readWatermarkedLines,
} from "../dist/worker/watermark.js";

/**
 * #196 finding 3, made mechanical.
 *
 * Spike A measured Vercel Sandbox replay losing lines 97–120 on a first read and delivering
 * them on a second 40 s later, and found chunk boundaries unstable and able to fall mid-line.
 * A "read from where I stopped" reader turns that into silent loss of `test_finished` and
 * `file_changed` events — invisible until someone asks why a run has no test results.
 *
 * Every case below fails against the reader this replaced (`offset = contents.length` plus an
 * in-memory `partialLine`): the last two because that reader's cursor is only correct while the
 * held partial survives, and the first two because it advances past bytes it never delivered.
 */

const buf = (s) => Buffer.from(s, "utf8");

test("a lossy tail delivers every line exactly once, in order, across reads", () => {
  const all = Array.from({ length: 12 }, (_, i) => `line-${i + 1}`);

  // Read 1 omits the last 4 lines and **stops mid-word** — Spike A's shape: the settled output
  // is there, the live tail is not, and the boundary does not respect lines. Read 2 heals it.
  //
  // The mid-line cut is the part that matters. An earlier version of this test cut on a newline
  // and passed against the naive reader too, which made it worthless as a guard: a tail that
  // happens to end on a boundary is the one case the naive reader gets right.
  const first = buf(all.slice(0, 8).join("\n") + "\nline-9 is only half writ");
  const second = buf(all.join("\n") + "\n");

  const reader = new WatermarkedLineReader();
  const delivered = [...reader.read(first), ...reader.read(second)];

  assert.deepEqual(delivered, all, "every line, once, in order");
  assert.equal(new Set(delivered).size, delivered.length, "no duplicates");
});

test("the watermark never advances past a line it did not deliver", () => {
  // The source ends mid-line: `line-3` has no newline yet.
  const partial = buf("line-1\nline-2\nline-3");
  const { lines, watermark } = readWatermarkedLines(partial, 0);

  assert.deepEqual(lines, ["line-1", "line-2"]);
  assert.equal(watermark, "line-1\nline-2\n".length, "stops after the last delivered newline");
  assert.notEqual(watermark, partial.length, "not at the end of what was read");

  // The rest of line-3 arrives. It is delivered whole, not as a fragment.
  const complete = buf("line-1\nline-2\nline-3\nline-4\n");
  assert.deepEqual(readWatermarkedLines(complete, watermark).lines, ["line-3", "line-4"]);
});

test("chunk boundaries falling mid-line split or duplicate nothing", () => {
  const source = "alpha\nbravo\ncharlie\ndelta\necho\n";
  const full = buf(source);

  // Every possible boundary, one at a time: read the source truncated at i, then in full.
  for (let i = 0; i <= source.length; i++) {
    const reader = new WatermarkedLineReader();
    const delivered = [...reader.read(full.subarray(0, i)), ...reader.read(full)];
    assert.deepEqual(
      delivered,
      ["alpha", "bravo", "charlie", "delta", "echo"],
      `a boundary at byte ${i} changed what was delivered`,
    );
  }
});

test("a multi-byte character split across a boundary is not mangled", () => {
  // The line is only ever decoded once it is complete, so a UTF-8 sequence cut in half by a
  // read boundary is reassembled as bytes rather than decoded twice into replacement chars.
  const source = buf("naïve — 日本語\nsecond\n");
  const cut = source.length - "second\n".length - 4; // mid-way through the multi-byte line
  const reader = new WatermarkedLineReader();
  const delivered = [...reader.read(source.subarray(0, cut)), ...reader.read(source)];
  assert.deepEqual(delivered, ["naïve — 日本語", "second"]);
  assert.ok(!delivered.join("").includes("�"), "no replacement characters");
});

test("a source that comes back shorter stands still rather than re-delivering", () => {
  const long = buf("a\nb\nc\nd\n");
  const reader = new WatermarkedLineReader();
  assert.deepEqual(reader.read(long), ["a", "b", "c", "d"]);
  const held = reader.watermark;

  // The lying tail, in the other direction. Re-delivering would duplicate four events.
  const short = buf("a\nb\n");
  assert.deepEqual(reader.read(short), []);
  assert.equal(reader.watermark, held, "the watermark does not rewind");

  const { regressed } = readWatermarkedLines(short, held);
  assert.equal(regressed, true, "and the condition is reported, not swallowed");

  // Healing delivers only what is genuinely new.
  assert.deepEqual(reader.read(buf("a\nb\nc\nd\ne\n")), ["e"]);
});

test("flushPartial delivers the trailing fragment, and only when asked", () => {
  const killed = buf('{"a":1}\n{"b":2}\n{"trunc');

  const streaming = readWatermarkedLines(killed, 0);
  assert.deepEqual(streaming.lines, ['{"a":1}', '{"b":2}'], "a running writer keeps its fragment");

  // A truncated trailing line is the expected shape of a killed run: delivering it lets the
  // consumer decide, rather than losing it.
  const final = readWatermarkedLines(killed, 0, { flushPartial: true });
  assert.deepEqual(final.lines, ['{"a":1}', '{"b":2}', '{"trunc']);
  assert.equal(final.watermark, killed.length);
});

test("empty lines are preserved rather than swallowed", () => {
  assert.deepEqual(readWatermarkedLines(buf("a\n\nb\n"), 0).lines, ["a", "", "b"]);
});

test("a negative watermark is refused rather than silently clamped", () => {
  assert.throws(() => readWatermarkedLines(buf("a\n"), -1), /must not be negative/);
});

/**
 * The property the other cases sample: for any sequence of partial views of a growing source,
 * concatenating what each read delivers reproduces the source's complete lines exactly once.
 */
test("across an arbitrary sequence of growing, lossy reads, nothing is lost or duplicated", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `event-${i}`);
  const full = buf(lines.join("\n") + "\n");

  // A deterministic walk of prefix lengths that jitters backwards as well as forwards, standing
  // in for a tail that appears, disappears and reappears.
  const reader = new WatermarkedLineReader();
  const delivered = [];
  let end = 0;
  for (let step = 0; step < 60; step++) {
    end = Math.min(full.length, Math.max(0, end + ((step * 37) % 29) - 7));
    delivered.push(...reader.read(full.subarray(0, end)));
  }
  delivered.push(...reader.read(full));

  assert.deepEqual(delivered, lines);
});
