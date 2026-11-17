import assert from "node:assert/strict";
import { priceAfterDiscount } from "./discount.js";

assert.equal(priceAfterDiscount(1000, 0), 1000);
assert.throws(() => priceAfterDiscount(1000, 101), RangeError);
console.log("2 passing");
