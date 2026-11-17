import assert from "node:assert/strict";
import { redact } from "./redact.js";

assert.equal(redact("a?token=abc123"), "a?token=REDACTED");
assert.equal(redact("a?password=hunter2"), "a?password=REDACTED");
console.log("2 passing");
