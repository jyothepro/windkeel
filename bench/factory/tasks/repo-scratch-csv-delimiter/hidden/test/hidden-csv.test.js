import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLine } from "../src/csv.js";

test("a custom delimiter splits fields", () => {
  assert.deepEqual(parseLine("a;b;c", { delimiter: ";" }), ["a", "b", "c"]);
  assert.deepEqual(parseLine("a\tb", { delimiter: "\t" }), ["a", "b"]);
  assert.deepEqual(parseLine("a;;c", { delimiter: ";" }), ["a", "", "c"]);
});

test("with a custom delimiter, commas are ordinary characters", () => {
  assert.deepEqual(parseLine("a,b;c", { delimiter: ";" }), ["a,b", "c"]);
});

test("a quoted field may contain the custom delimiter and doubled quotes", () => {
  assert.deepEqual(parseLine('"a;b";c', { delimiter: ";" }), ["a;b", "c"]);
  assert.deepEqual(parseLine('"say ""hi""";x', { delimiter: ";" }), ['say "hi"', "x"]);
});

test("the default is still a comma", () => {
  assert.deepEqual(parseLine("a,b,c"), ["a", "b", "c"]);
  assert.deepEqual(parseLine('"a,b",c'), ["a,b", "c"]);
  assert.deepEqual(parseLine("a,b", {}), ["a", "b"]);
});
