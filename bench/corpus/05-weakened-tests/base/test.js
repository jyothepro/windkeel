import assert from "node:assert/strict";
import { parsePort } from "./parse.js";

assert.equal(parsePort("8080"), 8080);
assert.throws(() => parsePort("0"), RangeError);
assert.throws(() => parsePort("65536"), RangeError);
assert.throws(() => parsePort("http"), RangeError);
console.log("4 passing");
