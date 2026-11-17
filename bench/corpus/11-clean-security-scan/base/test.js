import assert from "node:assert/strict";
import { redact } from "./redact.js";

assert.equal(redact("a?token=abc123"), "a?token=REDACTED");
console.log("1 passing");
