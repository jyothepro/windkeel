import assert from "node:assert/strict";
import { archiveName } from "./extract.js";

assert.equal(archiveName(7), "bundle-7.tar");
console.log("1 passing");
