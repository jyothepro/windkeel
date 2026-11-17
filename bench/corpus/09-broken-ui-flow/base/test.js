import assert from "node:assert/strict";
import { canPlaceOrder } from "./cart.js";

assert.equal(canPlaceOrder({ items: [1], address: "1 Main St" }), true);
console.log("1 passing");
