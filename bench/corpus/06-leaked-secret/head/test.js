import assert from "node:assert/strict";
import { endpoint } from "./client.js";

assert.equal(endpoint("us-east-1"), "https://api.us-east-1.example.com");
console.log("1 passing");
