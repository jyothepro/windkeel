import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLine } from "../src/csv.js";

test("splits on commas", () => {
  assert.deepEqual(parseLine("a,b,c"), ["a", "b", "c"]);
  assert.deepEqual(parseLine("a,,c"), ["a", "", "c"]);
});

test("a quoted field keeps its commas and its doubled quotes", () => {
  assert.deepEqual(parseLine('"a,b",c'), ["a,b", "c"]);
  assert.deepEqual(parseLine('"say ""hi""",x'), ['say "hi"', "x"]);
});
