import assert from "node:assert/strict";
import { test } from "node:test";
import { clientIp, createRateLimiter } from "./rate-limit.ts";

test("allows up to the limit inside the window, then refuses with a retry time", () => {
  let now = 0;
  const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => now });
  assert.equal(limiter.check("a").allowed, true);
  now = 10_000;
  assert.equal(limiter.check("a").allowed, true);
  now = 20_000;
  assert.deepEqual(limiter.check("a"), { allowed: false, retryAfterSeconds: 40 });
});

test("counts each key separately", () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 });
  assert.equal(limiter.check("a").allowed, true);
  assert.equal(limiter.check("b").allowed, true);
  assert.equal(limiter.check("a").allowed, false);
});

test("allows again once the window has passed", () => {
  let now = 0;
  const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => now });
  assert.equal(limiter.check("a").allowed, true);
  now = 1001;
  assert.equal(limiter.check("a").allowed, true);
});

test("forgets the oldest key past the key cap", () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0, maxKeys: 2 });
  limiter.check("a");
  limiter.check("b");
  limiter.check("c");
  assert.equal(limiter.check("a").allowed, true);
});

test("reads the client address from forwarding headers", () => {
  assert.equal(clientIp(new Headers({ "x-forwarded-for": "203.0.113.4, 10.0.0.1" })), "203.0.113.4");
  assert.equal(clientIp(new Headers({ "x-real-ip": "198.51.100.2" })), "198.51.100.2");
  assert.equal(clientIp(new Headers()), "unknown");
});
