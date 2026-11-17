import assert from "node:assert/strict";
import { format } from "./report.js";

assert.equal(format([{ name: "catch", value: 1 }]), "catch: 1");
console.log("1 passing");
