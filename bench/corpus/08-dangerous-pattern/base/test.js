import assert from "node:assert/strict";
import { resolveRef } from "./git.js";

assert.equal(typeof resolveRef, "function");
console.log("1 passing");
