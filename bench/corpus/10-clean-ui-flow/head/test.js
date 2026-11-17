import assert from "node:assert/strict";
import { canPlaceOrder } from "./cart.js";

assert.equal(canPlaceOrder({ items: [1], address: "1 Main St" }), true);
assert.equal(canPlaceOrder({ items: [1], address: null }), false);
assert.equal(canPlaceOrder({ items: [1], address: "" }), false);
console.log("3 passing");
